import { Guest } from '@/interfaces/guest.interface';
import { model, Schema, Document } from 'mongoose';

const GuestSchema: Schema = new Schema({
    session_uuid: {
        type: String,
        required: true,
        unique: true,
    },
    display_name: {
        type: String,
        required: true,
    },
    is_bot: {
        type: Boolean,
        default: false,
        index: true,
    },
    bot_skill: {
        type: Number,
        min: 0,
        max: 1,
    },
    metadata: {
        type: Object,
        default: {},
        select: false
    },
}, { timestamps: true });

export const GuestModel = model<Guest & Document>('guest', GuestSchema);
GuestModel.syncIndexes({ background: true });;
