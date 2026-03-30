import { Guest } from '@/interfaces/guest.interface';
import { model, Schema, Document } from 'mongoose';

const GuestSchema: Schema = new Schema({
    session_uuid: {
        type: String,
        required: true,
        unique: true,
    },
    metadata: {
        type: Object,
        default: {},
        select: false
    },
}, { timestamps: true });

export const GuestModel = model<Guest & Document>('guest', GuestSchema);
GuestModel.syncIndexes({ background: true });;
