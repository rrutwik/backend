import { ObjectId } from "mongoose";
import { Message } from "./message.interface";

export interface ChatSession {
  _id?: string,
  user_id: string | ObjectId | {
    prompt: string
  },
  name: string,
  chatbot_id?: {
    prompt: string
  } | string | ObjectId,
  uuid?: string,
  can_message?: boolean,
  deleted_at?: Date | null,
  messages?: Message[],
  created_at?: Date,
  updated_at?: Date
};
