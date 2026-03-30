import { model, Schema, Document } from 'mongoose';
import { Session } from '@interfaces/session.interface';

const SessionSchema: Schema = new Schema({
    user_id: {
        type: String,
        required: true,
        index: true,
    },
    session_token: {
        type: String,
        required: true,
        unique: true,
    },
    refresh_token: {
        type: String,
        required: true,
        unique: true,
    },
    expiresAt: {
        type: Date,
        required: true,
    },
    refreshExpiresAt: {
        type: Date,
        required: true,
    },
}, { timestamps: true });

export const SessionModel = model<Session & Document>('session', SessionSchema);
SessionModel.syncIndexes({ background: true });;
