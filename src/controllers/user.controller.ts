import { NextFunction, Response } from 'express';
import { Payment, PaymentMethod, PaymentStatus, PaymentType, User } from '@interfaces/users.interface';
import { RequestWithUser, UpdateProfileRequest } from '@/interfaces/auth.interface';
import { PaymentModel } from '@/models/payments.model';
import Razorpay from 'razorpay';
import { UserProfileModel } from '@/models/user_profile.model';
import { ChatSessionModel } from '@/models/chat_session.model';
import { ChatSession } from '@/interfaces/chatsession.interface';
import { RAZORPAY_KEY, RAZORPAY_SECRET } from '@/config';
import moment from 'moment-timezone';
import { logger } from '@/utils/logger';
import { UserService } from '@/services/users.service';
import { Container } from 'typedi';

var razorPayInstance = new Razorpay({
  key_id: RAZORPAY_KEY,
  key_secret: RAZORPAY_SECRET
});

const totalTokensToAddPerRupee = 1;

export class UserController {
  private userService = Container.get(UserService);
  public getProfile = async (req: RequestWithUser, res: Response, next: NextFunction) => {
    try {
      const user: User = req.user;
      if (!user) {
        throw new Error('User not found');
      }
      const profile = await UserProfileModel.findOne({ user_id: user._id });
      return res.status(200).json({ data: profile });
    } catch (error) {
      next(error);
    }
  }
  private allowedLanguages = ['en', 'hi', 'mr', 'ta', 'kn', 'ml', 'gu', 'or', 'bn', 'pa'];
  public updateProfile = async (req: UpdateProfileRequest, res: Response, next: NextFunction) => {
    try {
      const user: User = req.user;
      const { language } = req.body;
      if (!user) {
        throw new Error('User not found');
      }
      if (!language) {
        throw new Error('Language not found');
      }
      if (!this.allowedLanguages.includes(language)) {
        throw new Error('Language not allowed');
      }
      const profile = await UserProfileModel.findOneAndUpdate({ user_id: user._id }, { language }, { new: true });
      this.userService.clearUserProfileCache(user._id);
      return res.status(200).json({ data: profile });
    } catch (error) {
      next(error);
    }
  }

  public getChatHistory = async (req: RequestWithUser, res: Response, next: NextFunction) => {
    try {
      const user: User = req.user;
      if (!user) {
        throw new Error('User not found');
      }
      const chatSessionModel: ChatSession = await ChatSessionModel.findOne({
        user_id: user._id,
        deleted_at: null,
      });
      const messages = chatSessionModel.messages;
      return res.status(200).json({
        status: 200,
        data: messages
      });
    } catch (error) {
      next(error);
    }
  }

  public createRazorpayOrder = async (req: RequestWithUser, res: Response, next: NextFunction) => {
    try {
      const amount = req.body.amount;
      const user: User = req.user;
      if (!user) {
        throw new Error('User not found');
      }
      const razorPayAmount = Number(amount * 100);
      if (!razorPayAmount || isNaN(razorPayAmount)) {
        throw new Error('Invalid amount');
      }

      if (razorPayAmount / 100 > 500) {
        return res.status(403).json({
          message: 'Only Less than 500 are allowed'
        });
      }
      const dbCreateOrder: Payment = {
        user_id: user._id,
        amount: amount,
        type: PaymentType.PAYMENT,
        method: PaymentMethod.RAZORPAY,
        status: PaymentStatus.CREATED,
      };
      const paymentModel = await PaymentModel.create(dbCreateOrder);
      // const razorPayOrderResponse = await axios.post("https://api.razorpay.com/v1/orders", {
      //   amount: razorPayAmount,
      //   payment_capture: true,
      //   currency: 'INR',
      // });
      const razorPayOrder = await razorPayInstance.orders.create({
        amount: razorPayAmount,
        payment_capture: true,
        currency: 'INR',
        payment: {
          capture: 'automatic',
          capture_options: {
            automatic_expiry_period: 100,
            manual_expiry_period: 150,
            refund_speed: 'normal'
          }
        }
      });
      if (!razorPayOrder) {
        throw new Error('Order creation failed');
      }
      if (!razorPayOrder.id) {
        throw new Error('Order id not found');
      }
      const orderId = razorPayOrder.id;
      const updatedPaymentModel = await PaymentModel.findOneAndUpdate({
        _id: paymentModel._id,
      }, {
        status: PaymentStatus.PENDING,
        razorpay_order_id: orderId,
        props: {
          ...paymentModel.props,
          razorpay_create_object: razorPayOrder,
        }
      });
      this.getRazorpayPayment(updatedPaymentModel, user);
      return res.status(201).json({ order_id: orderId, key_id: RAZORPAY_KEY });
    } catch (error) {
      logger.error(`${error} ${error?.stack}`);
      next(error);
    }
  }

  private getRazorpayPayment = async (previousPaymentEntry: Payment, user: User, waitTime: number = 0) => {
      await new Promise((resolve) => setTimeout(resolve, waitTime));

      if (!previousPaymentEntry) {
        throw new Error('Payment not found');
      }

      logger.info(`Checking payment status for ${previousPaymentEntry._id} for user ${user._id} ${previousPaymentEntry.user_id.toString() === user._id.toString()} `);

      if (previousPaymentEntry.user_id.toString() !== user._id.toString()) {
        throw new Error('Payment not found');
      }

      const payment = await PaymentModel.findOne({
        _id: previousPaymentEntry._id,
      });

      if (payment.status === PaymentStatus.PENDING) {

        const [razorPayStatus, razorpayOrderPayments] = await Promise.all([
          razorPayInstance.orders.fetch(payment.razorpay_order_id),
          razorPayInstance.orders.fetchPayments(payment.razorpay_order_id),
        ]);

        logger.info(`Razorpay Payment status for ${payment._id} ${JSON.stringify(razorPayStatus)} and payments ${JSON.stringify(razorpayOrderPayments)}`);

        if (razorPayStatus?.status === 'paid') {

          const successPayments = razorpayOrderPayments.items.filter((item: any) => item.status === 'captured');

          if (successPayments.length > 0) {
            const updatedPayment = await PaymentModel.findOneAndUpdate({
              _id: payment._id,
            }, {
              status: PaymentStatus.SUCCESS,
              props: {
                ...payment.props,
                razorpay_payment_status_object: razorPayStatus,
                success_payments: successPayments
              },
            });
            const totalAmount = updatedPayment.amount;
            // on success payment start
            const tokensToAdd = totalAmount * totalTokensToAddPerRupee;
            await UserProfileModel.findOneAndUpdate(
              { user_id: user._id },
              { $inc: { credits: tokensToAdd } },
              { new: true },
            );
            return;
          }

        }

        const failedPayments = razorpayOrderPayments.items.filter((item: any) => item.status === 'failed');
        if (failedPayments.length > 0) {

          await PaymentModel.findOneAndUpdate({
            _id: payment._id,
          }, {
            status: PaymentStatus.FAILED,
            props: {
              ...payment.props,
              razorpay_payment_status_object: razorPayStatus,
              failed_payments: failedPayments
            },
          });

        }

        // exponential backoff
        const newWaitTime = waitTime === 0 ? 1000 : waitTime * 2;
        const createdOn = moment(payment.createdAt);
        const diff = moment().diff(createdOn, 'hours');
        if (diff > 24) {
          await PaymentModel.findOneAndUpdate({
            _id: payment._id,
          }, {
            status: PaymentStatus.FAILED,
            props: {
              ...payment.props,
              razorpay_payment_status_object: razorPayStatus
            },
          });
          return;
        }
        this.getRazorpayPayment(payment, user, newWaitTime);
      }
  }

  public getRazorpayOrder = async (req: RequestWithUser, res: Response, next: NextFunction) => {
    try {
      const orderId = req.query.order_id;
      const user: User = req.user;
      if (!user) {
        throw new Error('User not found');
      }
      const payment = await PaymentModel.findOne({
        razorpay_order_id: orderId,
        user_id: user._id
      });
      logger.info(`User Id ${user._id}`);
      if (!payment) {
        throw new Error('Payment not found');
      }
      logger.info(`User ${user._id} Payment ${payment.user_id}`);
      if (payment.user_id.toString() !== user._id.toString()) {
        throw new Error('Payment not found');
      }
      if (payment.status === PaymentStatus.PENDING) {
        this.getRazorpayPayment(payment, user);
        const updatedPayment = await PaymentModel.findOne({
          _id: payment._id
        });
        return res.status(200).json(updatedPayment);
      }
      return res.status(200).json(payment);
    } catch (error) {
      next(error);
    }
  }
}
