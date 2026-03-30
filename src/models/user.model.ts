import { model, Schema, Document, Model } from 'mongoose';
import { PasswordResetObject, User } from '@interfaces/users.interface';
import { getHashedPassoword } from '@/utils/encrypt';
import { logger } from '@/utils/logger';

interface PasswordResetObjectDocument extends PasswordResetObject, Document { }

const PasswordResetObjectSchema: Schema<PasswordResetObjectDocument> = new Schema<PasswordResetObjectDocument>({
  reset_token: {
    type: String,
    index: true,
    required: true,
  },
  reset_token_expiry: {
    type: Date,
    required: true,
  },
});

const UserSchema: Schema = new Schema({
  email: {
    type: String,
    required: true,
    unique: true,
  },
  password_reset_object: {
    type: PasswordResetObjectSchema,
    default: null,
  }
}, {
  timestamps: true
});

UserSchema.set("toJSON", {
  transform: function (doc, ret) {
    delete ret.password;
    delete ret.__v;
    delete ret.password_reset_object;
    return ret;
  }
});

export const UserModel = model<User & Document>('user', UserSchema);
UserModel.syncIndexes({ background: true });;
