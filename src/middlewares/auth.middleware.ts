import { NextFunction, Response } from 'express';
import { verify, TokenExpiredError } from 'jsonwebtoken';
import { SECRET_KEY } from '@config';
import { HttpException } from '@exceptions/HttpException';
import { DataStoredInToken, RequestWithGuest, RequestWithUser } from '@interfaces/auth.interface';
import { logger } from '@/utils/logger';
import { UserService } from '@/services/users.service';
import { SessionDBService } from '@/dbservice/session';
import { GuestModel } from '@/models/guest.model';
import { cache } from '@/cache';

const getAuthorization = (req: RequestWithUser) => {
  const cookie = req.cookies['Authorization'];
  if (cookie) return cookie;

  const header = req.header('Authorization');
  if (header) return header.split('Bearer ')[1];

  return null;
}

export const AuthMiddleware = async (req: RequestWithUser, res: Response, next: NextFunction) => {
  if (req.guest) {
    logger.info('Guest session detected, skipping authentication middleware');
    return next();
  }
  const userService = new UserService();
  const sessionDBService = new SessionDBService();

  try {
    const token = getAuthorization(req);

    if (token) {
      const session = await sessionDBService.getSessionBySessionToken(token);
      if (session) {
        const { _id } = (verify(token, SECRET_KEY)) as DataStoredInToken;

        const findUser = await userService.getUserFromID(_id);

        if (findUser) {
          req.user = findUser;
          return next();
        } else {
          logger.error('User not found for session token: ' + token + ' and user id: ' + _id);
          return next(new HttpException(401, 'Wrong authentication token'));
        }
      } else {
        logger.error('Session not found for session token: ' + token);
        return next(new HttpException(401, 'Wrong authentication token'));
      }
    } else {
      logger.error('Session token not found');
      return next(new HttpException(401, 'Wrong authentication token'));
    }
  } catch (error) {
    logger.info(`Error in auth middleware: ${error}`);
    logger.error(error);
    if (error instanceof TokenExpiredError) {
      return next(new HttpException(401, 'Token expired'));
    } else {
      logger.error(`Other token verification error: ${error}`);
    }
    return next(new HttpException(401, 'Wrong authentication token'));
  }
};

export const GuestMiddleware = async (req: RequestWithGuest, res: Response, next: NextFunction) => {
  try {
    const token = req.headers['x-guest-token'] as string;
    if (token) {
      const guest = await GuestModel.findOne({ session_uuid: token });
      if (guest) {
        req.guest = guest; // No user associated with guest session
        return next();
      } else {
        logger.error(`Guest session not found for token: ${token}`);
        return next(new HttpException(401, 'Unexpected error occurred'));
      }
    }
    logger.error('Guest token not found in headers');
    return next(new HttpException(401, 'Unexpected error occurred'));
  } catch (error) {
    logger.info(`Error in guest middleware: ${error}`);
    logger.error(error);
    return next(new HttpException(401, 'Unexpected error occurred'));
  }
}

