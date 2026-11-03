import { Router } from 'express';
import { Routes } from '@interfaces/routes.interface';
import { ChatController } from '@/controllers/chat.controller';
import { AuthMiddleware } from '@/middlewares/auth.middleware';

export class ChatRoute implements Routes {
  public path = '/chat';
  public router = Router();
  public chatController = new ChatController();

  constructor() {
    this.initializeRoutes();
  }

  private initializeRoutes() {
    this.router.post(`${this.path}/message`, AuthMiddleware, this.chatController.handleMessageOfUser);
    this.router.get(`${this.path}/messages/:sessionId`, AuthMiddleware, this.chatController.getMessagesOfSession);
    this.router.get(`${this.path}`, AuthMiddleware, this.chatController.getChats);
    this.router.get(`${this.path}/:id`, AuthMiddleware, this.chatController.getChat);
    this.router.patch(`${this.path}/:id`, AuthMiddleware, this.chatController.renameChat);
    this.router.delete(`${this.path}/:id`, AuthMiddleware, this.chatController.deleteChat);
  }
}
