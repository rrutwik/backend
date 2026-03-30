import { model, Schema, Document, Types } from 'mongoose';
import { ChatSession } from '@/interfaces/chatsession.interface';

export enum MessageRole {
    USER = 1,
    ASSISTANT = 2,
    SYSTEM = 3
}

const MessageSchema = new Schema({
    _id: {
        type: Schema.Types.ObjectId,
        default: () => new Types.ObjectId(),
        index: true
    },
    type: {
        type: String,
        default: 'text',
        required: true
    },
    text: {
        type: String,
        required: true
    },
    role: {
        type: Number,
        enum: Object.values(MessageRole),
        required: true
    },
    usage_metadata: {
        type: Object
    },
    createdAt: {
        type: Date,
        default: Date.now
    },
    updatedAt: {
        type: Date,
        default: Date.now
    }
});

const ChatSessionSchema: Schema = new Schema({
    name: {
      type: String,
      default: 'Chat Session',
      required: true
    },
    user_id: {
        type: Schema.Types.ObjectId,
        required: true,
        index: true,
        ref: 'user' // Reference to the Chatbot collectio
    },
    chatbot_id: {
        type: Schema.Types.ObjectId,
        required: true,
        index: true,
        ref: 'chatbot'
    },
    uuid: {
        type: String,
        required: true,
        index: true,
        default: () => {
            return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
        },
        unique: true
    },
    can_message: {
        type: Boolean,
        required: true,
        default: false
    },
    messages: {
        type: [MessageSchema],
        required: true,
        default: []
    }
}, { timestamps: true });

export const ChatSessionModel = model<ChatSession & Document>('chat_session', ChatSessionSchema);
ChatSessionModel.syncIndexes({ background: true });;
