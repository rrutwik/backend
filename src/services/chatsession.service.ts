import { DatabaseException } from "@/exceptions/DependencyException";
import { Agent } from "@/external/agents/agent";
import { ChatBot } from "@/interfaces/chatbot.interface";
import { ChatSession } from "@/interfaces/chatsession.interface";
import { Message } from "@/interfaces/message.interface";
import { User } from "@/interfaces/users.interface";
import { ChatSessionModel, MessageRole } from "@/models/chat_session.model";
import { UserProfileModel } from "@/models/user_profile.model";
import { logger } from "@/utils/logger";
import { UserService } from "@/services/users.service";
import Container, { Service } from "typedi";

@Service()
export class ChatSessionService {
    private agent = new Agent();
    public async createChatSession(user: User, name: string = 'Chat Session', chatbotId: string): Promise<ChatSession> {
        const data: ChatSession = { user_id: user._id, name: name, chatbot_id: chatbotId };
        const session = await ChatSessionModel.create(data);
        return session;
    }

    public async getSessionByUUID(uuid: string, userId: string): Promise<ChatSession> {
      return await (ChatSessionModel.findOne({ uuid: uuid, user_id: userId }).populate('chatbot_id').exec());
    }

    public async addMessageToSession(session: ChatSession, message: string, userId: string): Promise<ChatSession> {
        try {
          const [dbSession, userProfile] = await Promise.all([
            ChatSessionModel.findOne(
              { user_id: userId, uuid: session.uuid },
            ).populate('chatbot_id'),
            UserProfileModel.findOne({ user_id: userId })
          ]);

          if (!dbSession) {
              logger.error(`Error while adding message to session: ${session._id}`);
              throw new DatabaseException(new Error("Session not found"));
          }

          const language = userProfile.language ?? 'en';
        
          const userMessage: Message = {
            text: message,
            type: 'text',
            role: MessageRole.USER,
          };

          return await new Promise((resolve, reject) => {
            const userUpdatedChatSession = (chatSession: ChatSession) => {
              resolve(chatSession);
            }
            // The credit is charged before the model runs, so give it back if the model fails.
            // reject() is a no-op once the request has already been answered.
            const onFailure = async (error: Error) => {
              await UserProfileModel.updateOne({ user_id: userId }, { $inc: { credits: 1 } });
              await Container.get(UserService).clearUserProfileCache(userId);
              reject(error);
            };
            this.agent.sendMessageToAgent(userMessage.text, language, dbSession, (dbSession.chatbot_id as ChatBot)?.prompt, userUpdatedChatSession, onFailure);
          });
        } catch (error) {
            const errorMessage = `Error while adding message to session: ${session._id}`;
            logger.error(`${errorMessage} ${error} ${error.stack}`);
            throw new DatabaseException(error);
        }
    }

    public async getMessagesForSession(session: ChatSession): Promise<Message[]> {
        try {
            return session.messages.map((message) => ({
              ...message,
              createdAt: message.createdAt || new Date(),
              updatedAt: message.updatedAt || new Date(),
            }));
        } catch (error) {
            const errorMessage = `Error while getting messages for session: ${session._id}`;
            logger.error(errorMessage);
            throw new DatabaseException(error);
        }
    }
}
