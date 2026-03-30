import { model, Schema, Document, Types } from 'mongoose';
import { ChatBot } from '@/interfaces/chatbot.interface';

const ChatBotSchema: Schema = new Schema({
    name: {
      type: String,
      required: true
    },
    id: {
      type: String,
      required: true,
    },
    description: {
      type: String,
      required: true
    },
    religion: {
      type: String,
      required: true
    },
    avatar: {
      type: String,
      required: true
    },
    greeting: {
      type: String,
      required: true
    },
    prompt: {
      type: String,
      required: true
    },
}, { timestamps: true });

export const ChatBotModel = model<ChatBot & Document>('chatbot', ChatBotSchema);
ChatBotModel.syncIndexes({ background: true });;
