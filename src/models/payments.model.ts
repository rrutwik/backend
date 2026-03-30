import { Payment, PaymentMethod, PaymentStatus, PaymentType } from "@/interfaces/users.interface";
import { Document, Schema, model } from "mongoose";


const PaymentModelSchema = new Schema({
    user_id: {
        type: String,
        required: true,
        index: true
    },
    type: {
        type: String,
        enum: Object.values(PaymentType),
        required: true
    },
    amount: {
        type: Number,
        required: true
    },
    method: {
        type: String,
        enum: Object.values(PaymentMethod),
        default: PaymentMethod.RAZORPAY,
        required: true,
    },
    razorpay_order_id: {
        type: String,
        index: true,
        default: null
    },
    props: {
        type: Object,
        required: true,
        default: {}
    },
    status: {
        type: String,
        enum: Object.values(PaymentStatus),
        default: PaymentStatus.CREATED,
        required: true
    },
}, { timestamps: true });

export const PaymentModel = model<Payment & Document>('payment', PaymentModelSchema);
PaymentModel.syncIndexes({ background: true });;
