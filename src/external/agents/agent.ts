import { ChatSession } from "@/interfaces/chatsession.interface";
import { logger } from "@/utils/logger";
import { HumanMessage, AIMessage, BaseMessage, SystemMessage } from "@langchain/core/messages";
import { ChatSessionModel, MessageRole } from "@/models/chat_session.model";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatPromptTemplate, HumanMessagePromptTemplate, MessagesPlaceholder, SystemMessagePromptTemplate } from "@langchain/core/prompts";
import { GEMINI_API_KEY, GEMINI_MODEL_NAME } from "@/config";
import Redis from "ioredis";
import { sha256, } from "@langchain/core/utils/hash";
import { ChatBot } from "@/interfaces/chatbot.interface";
import { throttle } from 'lodash';
import { concat } from "@langchain/core/utils/stream";
import { env } from "@/env";
import RedisCache from "@/utils/rediscache";


const modelName = GEMINI_MODEL_NAME;
if (!GEMINI_API_KEY) {
  // Failed replies refund the user's credit, so a missing key would otherwise go unnoticed.
  logger.error("GEMINI_API_KEY is not set: every chat reply will fail (users get a refund and an apology message).");
}
const FALLBACK_REPLY = "Sorry, I couldn't reply just now. Please try again in a moment. Your credit has been returned.";
const languageMapping = {
  en: "English",
  hi: "Hindi",
  te: "Telugu",
  kn: "Kannada",
  ml: "Malayalam",
  ta: "Tamil",
  gu: "Gujarati",
  or: "Oriya",
  pa: "Punjabi"
}
const redisUrl = env.REDIS_URL;

const client = new Redis(redisUrl, {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
  keyPrefix: "backend_redis_client_ai_agent:",
  db: 0
});

let cacheClient: RedisCache | null = null;

function getCacheClient() {
  if (cacheClient) return cacheClient;
  cacheClient = new RedisCache(client, { ttl: 400 });
  cacheClient.makeDefaultKeyEncoder(sha256);
  return cacheClient;
}


export class Agent {
  private chatGPTModel = new ChatGoogleGenerativeAI({
    apiKey: GEMINI_API_KEY,
    temperature: 0,
    model: modelName,
    streaming: true,
    cache: getCacheClient(),
    callbacks: [{
      handleLLMEnd(output, runId, parentRunId, tags) {
        logger.debug(`${modelName} response: ${JSON.stringify(output)} for runId: ${runId} with tags: ${tags} and parentRunId: ${parentRunId}`);
      },
      handleLLMError(error, runId, parentRunId, tags) {
        logger.error(`${modelName} error: ${error} for runId: ${runId} with tags: ${tags} and parentRunId: ${parentRunId}`);
      },
      handleLLMStart(llm, prompts, runId, parentRunId, extraParams, tags, metadata, name) {
        logger.debug(`${modelName} start: ${llm} with prompts: ${prompts} for runId: ${runId} with tags: ${tags} and parentRunId: ${parentRunId}`);
      },
    }]
  });

  private getMessages(chatSession: ChatSession) {
    const messages = chatSession.messages;
    const history: BaseMessage[] = [];
    const lastFiveMessages = messages.slice(-5);
    lastFiveMessages.forEach((message) => {
      // Gemini rejects empty message parts. Empty assistant bubbles are left behind by replies that failed
      // earlier, and the apology text is not something the model said, so neither goes back into the history.
      if (!message.text || message.type === "error" || message.text === FALLBACK_REPLY) return;
      if (message.role === MessageRole.USER) {
        history.push(new HumanMessage(message.text));
      } else if (message.role === MessageRole.ASSISTANT) {
        history.push(new AIMessage(message.text));
      } else if (message.role === MessageRole.SYSTEM) {
        history.push(new SystemMessage(message.text));
      } else {
        throw new Error("Invalid message role");
      }
    });
    return history;
  }

  public async suggestChatSessionNameFromFirstMessage(message: string, bot: ChatBot): Promise<string> {
    const botName = bot.name;
    const religion = bot.religion;
    const botDescription = bot.description;
    const prompt = await ChatPromptTemplate.fromMessages([
      SystemMessagePromptTemplate.fromTemplate(`You are given a message from a user and a bot name and description and religion of the bot. Suggest a name for this chat session based on the message. Only suggest a name, do not add any additional text.`),
      HumanMessagePromptTemplate.fromTemplate("Message: {message}\nBot Name: {botName}\nBot Religion: {religion}\nBot Description: {botDescription}")
    ]);
    try {
      const output = await this.chatGPTModel.invoke(await prompt.format({ message, botName, religion, botDescription }));
      const name = output.text.trim();
      if (name) return name;
    } catch (error) {
      // A model outage must not stop the user from starting a chat; fall back to the message itself.
      logger.error(`Could not suggest chat session name, using the message instead: ${error}`);
    }
    return message.trim().slice(0, 40) || "Chat Session";
  }

  public async sendMessageToAgent(
    message: string,
    userLanguage: string,
    _chatSession: ChatSession,
    promptString: string,
    userUpdatedChatSession: (chatSession: ChatSession) => void,
    onFailure?: (error: Error) => void | Promise<void>
  ): Promise<void> {
    try {
      const chatSession = await this.addUserMessage(_chatSession, message);
      userUpdatedChatSession(chatSession);

      const formattedPrompt = await this.buildPrompt(_chatSession, message, promptString, userLanguage);
      const { aiMessage, messageId } = await this.streamAgentResponse(_chatSession, formattedPrompt);
      await this.updateAgentMessage(_chatSession, messageId, aiMessage);
    } catch (error) {
      logger.error(
        `Error while adding message to session: ${_chatSession._id} ${error} ${error.stack}`
      );
      await this.recoverSession(_chatSession);
      try {
        await onFailure?.(error);
      } catch (callbackError) {
        logger.error(`onFailure handler failed for session ${_chatSession._id}: ${callbackError}`);
      }
    }
  }

  // If the model call fails, unlock the chat and replace the empty assistant bubble
  // with a visible message, otherwise the user is stuck (can_message stays false forever).
  private async recoverSession(chatSession: ChatSession): Promise<void> {
    try {
      await ChatSessionModel.findOneAndUpdate(
        { _id: chatSession._id },
        {
          $set: {
            can_message: true,
            "messages.$[empty].text": FALLBACK_REPLY,
            // type "error" lets the app show a Retry button and keeps this text out of the model's history
            "messages.$[empty].type": "error",
            "messages.$[empty].updatedAt": new Date()
          }
        },
        { arrayFilters: [{ "empty.role": MessageRole.ASSISTANT, "empty.text": "" }] }
      );
    } catch (recoverError) {
      logger.error(`Could not recover chat session ${chatSession._id}: ${recoverError}`);
    }
  }

  private async addUserMessage(chatSession: ChatSession, message: string): Promise<ChatSession> {
    return await ChatSessionModel.findOneAndUpdate(
      { _id: chatSession._id },
      {
        can_message: false,
        $push: {
          messages: { text: message, role: MessageRole.USER }
        }
      },
      { new: true }
    );
  }

  private async buildPrompt(
    chatSession: ChatSession,
    message: string,
    promptString: string,
    userLanguage: string
  ): Promise<BaseMessage[]> {
    const allPast = this.getMessages(chatSession);
    // Gemini accepts exactly one system message and it must come first, so everything that is
    // a system message (the bot prompt, the language instruction, any stored system notes) is merged into one.
    const escapeBraces = (text: string) => text.replace(/[{}]/g, (c) => c + c);
    const systemNotes = allPast.filter((m) => m instanceof SystemMessage).map((m) => escapeBraces(m.text));
    const pastMessages = allPast.filter((m) => !(m instanceof SystemMessage));

    const systemText = [
      promptString,
      `You are given chat history for reference with new user message. Reply in ${languageMapping[userLanguage]} language while keeping your tone gentle and compassionate.`,
      ...systemNotes
    ].join("\n\n");

    const prompt = ChatPromptTemplate.fromMessages([
      SystemMessagePromptTemplate.fromTemplate(systemText),
      new MessagesPlaceholder("history"),
      HumanMessagePromptTemplate.fromTemplate("{inputMessage}")
    ]);

    return prompt.formatMessages({
      history: pastMessages,
      inputMessage: message
    });
  }

  private async streamAgentResponse(chatSession: ChatSession, prompt: BaseMessage[]): Promise<{
    aiMessage: AIMessage;
    messageId: string
  }> {
    logger.debug(`Prompt: ${prompt}`);

    const streamOutput = this.chatGPTModel.streamEvents(prompt, { version: 'v2' });

    const updatedSession = await ChatSessionModel.findOneAndUpdate(
      { _id: chatSession._id },
      {
        can_message: false,
        $push: { messages: { text: "", role: MessageRole.ASSISTANT } }
      },
      { new: true }
    );

    const messageId = updatedSession.messages[updatedSession.messages.length - 1]._id;

    let aiMessage: AIMessage = null;

    const updateMessageInDb = async (newContent: string) => {
      await ChatSessionModel.findOneAndUpdate(
        { _id: chatSession._id },
        { $set: { "messages.$[message].text": newContent, updatedAt: new Date() } },
        { arrayFilters: [{ "message._id": messageId }] }
      );
    };
    let currentContent = "";
    const throttleUpdate = throttle(updateMessageInDb, 500);
    for await (const chunkAIMessage of streamOutput) {
      logger.debug(`Agent response chunk: ${JSON.stringify(chunkAIMessage, null, 4)}`);
      if (chunkAIMessage.data.chunk) {
        if (aiMessage) {
          aiMessage = concat(aiMessage, chunkAIMessage.data.chunk);
        } else {
          aiMessage = chunkAIMessage.data.chunk;
        }
        currentContent = aiMessage.text;
        throttleUpdate(currentContent);
      }
    }

    logger.debug(`Agent response: ${JSON.stringify(currentContent, null, 4)}`);
    return {
      aiMessage,
      messageId
    };
  }

  private async updateAgentMessage(chatSession: ChatSession, messageId: string, agentMessage: AIMessage): Promise<void> {
    const usage_metadata = agentMessage.usage_metadata;
    await ChatSessionModel.findOneAndUpdate(
      { _id: chatSession._id },
      {
        can_message: true,
        $set: { "messages.$[message].text": agentMessage.text,"messages.$[message].usage_metadata": usage_metadata }
      },
      { arrayFilters: [{ "message._id": messageId }] }
    );
  }

}
