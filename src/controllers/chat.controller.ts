import { NextFunction, Response } from 'express';

import { AuthService } from '@services/auth.service';
import { Container } from 'typedi';
import { HandleMessageRequest, RequestWithUser } from '@interfaces/auth.interface';
import { User } from '@interfaces/users.interface';
import { UserService } from '@/services/users.service';
import { ChatSessionService } from '@/services/chatsession.service';
import { logger } from '@/utils/logger';
import { ChatSessionModel } from '@/models/chat_session.model';
import { UserProfileModel } from '@/models/user_profile.model';
import { Agent } from '@/external/agents/agent';
import { ChatSession } from '@/interfaces/chatsession.interface';
import { ChatBotModel } from '@/models/chat_bot.model';

export class ChatController {
  public authService = Container.get(AuthService);
  public userService = Container.get(UserService);
  public chatSessionService = Container.get(ChatSessionService);

  private agent = new Agent();

  private async updateChatSessionName(chatBotId: string, message: string): Promise<string> {
    const chatBot = await ChatBotModel.findById(chatBotId);
    const name = await this.agent.suggestChatSessionNameFromFirstMessage(message, chatBot);
    return name;
  }

  public handleMessageOfUser = async (req: HandleMessageRequest, res: Response, next: NextFunction) => {
    try {
      const user: User = req.user;
      const chatSessionUUID = req.body.chat_id;
      const chatBotId = req.body.chatbot_id;
      const message = req.body.message;
      let chatSession = null;
      if (chatSessionUUID) {
        chatSession = await this.chatSessionService.getSessionByUUID(chatSessionUUID, user._id);
      } else {
        const name = await this.updateChatSessionName(chatBotId, message);
        chatSession = await this.chatSessionService.createChatSession(user, name, chatBotId);
      }
      if (!chatSession) {
        logger.error(`error: chat session not found`);
        return res.status(404).json({ message: 'session not found' });
      }
      const userProfile = await UserProfileModel.findOne({
        user_id: user._id
      });
      if (userProfile.credits == 0) {
        return res.status(400).json({
          status: "1000",
          message: "Recharge First"
        });
      }
      await UserProfileModel.updateOne(
        { user_id: user._id },
        { $inc: { credits: -1 } }  // Decreases the credits by 1
      );
      this.userService.clearUserProfileCache(user._id);
      const updatedChatSession = await this.chatSessionService.addMessageToSession(chatSession, message, user._id);
      return res.status(200).json({ message: `message added to session ${updatedChatSession._id}`, data: updatedChatSession });
    } catch (error) {
      logger.error(`error: ${error} errorstack: ${error.stack} error message: ${error.message}`);
      next(error);
    }
  };

  public getMessagesOfSession = async (req: RequestWithUser, res: Response, next: NextFunction) => {
    try {
      const user: User = req.user;
      const sessionId = req.params.sessionId;
      const chatSession = await this.chatSessionService.getSessionByUUID(sessionId, user._id);
      if (!chatSession) {
        logger.error(`error: chat session not found`);
        return res.status(404).json({ message: 'session not found' });
      }
      const messages = await this.chatSessionService.getMessagesForSession(chatSession);
      return res.status(200).json({ messages, session_id: chatSession._id });
    } catch (error) {
      logger.error(`error: ${error} errorstack: ${error.stack} error message: ${error.message}`);
      next(error);
    }
  }

  public getChats = async (req: RequestWithUser, res: Response, next: NextFunction) => {
    try {
      const user: User = req.user;
      if (!user) {
        throw new Error('User not found');
      }
      const limit = Number(req.query.limit) || 10;
      const offset = Number(req.query.offset) || 0;

      const [chatSessions, total] = await Promise.all([
        ChatSessionModel.find({
          user_id: user._id,
          deleted_at: null,
        }, {
          name: 1,
          uuid: 1,
          updatedAt: 1,
          can_message: 1,
          chatbot_id: 1
        }, {
          sort: {
            updatedAt: -1
          }
        })
        .populate({
          path: 'chatbot_id',
          select: {
            name: 1
          }
        })
        .skip(offset)
        .limit(limit),
        ChatSessionModel.countDocuments({
          user_id: user._id,
          deleted_at: null,
        })
      ]);
      return res.status(200).json({
        data: {
          records: chatSessions,
          limit: limit,
          offset: offset,
          total: total
        }
      });
    } catch (error) {
      next(error);
    }
  }

  public getChat = async (req: RequestWithUser, res: Response, next: NextFunction) => {
    try {
      const user: User = req.user;
      if (!user) {
        throw new Error('User not found');
      }
      const chatSessionUUID = req.params.id;
      // Scoped to the signed-in user: without user_id any logged-in user could read any chat by uuid.
      const chatSession = await ChatSessionModel.findOne({
        uuid: chatSessionUUID,
        user_id: user._id,
        deleted_at: null,
      }).populate({
        path: 'chatbot_id',
        select: 'name', // Specifies that only the 'name' field should be populated
      });
      if (!chatSession) {
        return res.status(404).json({ message: 'session not found' });
      }
      return res.status(200).json({
        data: chatSession,
      });
    } catch (error) {
      next(error);
    }
  }

  public renameChat = async (req: RequestWithUser, res: Response, next: NextFunction) => {
    try {
      const user: User = req.user;
      const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 80) : '';
      if (!name) {
        return res.status(400).json({ message: 'name is required' });
      }
      const chatSession = await ChatSessionModel.findOneAndUpdate(
        { uuid: req.params.id, user_id: user._id, deleted_at: null },
        { $set: { name } },
        { new: true, projection: { name: 1, uuid: 1, updatedAt: 1 } }
      );
      if (!chatSession) {
        return res.status(404).json({ message: 'session not found' });
      }
      return res.status(200).json({ data: chatSession });
    } catch (error) {
      next(error);
    }
  }

  public deleteChat = async (req: RequestWithUser, res: Response, next: NextFunction) => {
    try {
      const user: User = req.user;
      // Soft delete: the chat disappears from the app but stays in the database (restorable by clearing deleted_at).
      const result = await ChatSessionModel.updateOne(
        { uuid: req.params.id, user_id: user._id, deleted_at: null },
        { $set: { deleted_at: new Date() } }
      );
      if (result.matchedCount === 0) {
        return res.status(404).json({ message: 'session not found' });
      }
      return res.status(200).json({ message: 'deleted' });
    } catch (error) {
      next(error);
    }
  }
}
