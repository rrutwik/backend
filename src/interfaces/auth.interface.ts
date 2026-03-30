import { Request } from 'express';
import { User } from '@interfaces/users.interface';
import { Guest } from './guest.interface';

export interface DataStoredInToken {
  _id: string;
}

export interface TokenData {
  token: string;
  expiresIn: number;
}

export interface UpdateProfileRequest extends RequestWithUser {
  body: {
    language?: string;
  }
}

export interface RequestWithUser extends Request {
  user: User;
  guest?: Guest;
}

export interface RequestWithGuest extends Request {
  guest: Guest;
}

export interface HandleMessageRequest extends RequestWithUser {
  body: {
      message: string,
      file_id?: string,
      chat_id: string
      chatbot_id: string
  }
}

export interface RefreshTokenRequest extends Request {
  body: {
    refresh_token: string;
  }
}

export interface GoogleLoginBody {
  client_id?: string;
  credential?: string;
  select_by?: string;
  code?: string;
  redirect_uri?: string;
}

export type GoogleLoginBodyWithLanguage = GoogleLoginBody & {
  language?: string;
}

export interface GoogleLoginRequest extends Request {
  body: GoogleLoginBodyWithLanguage;
}
