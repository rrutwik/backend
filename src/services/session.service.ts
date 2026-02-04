import Container, { Service } from 'typedi';
import { DataStoredInToken } from '@interfaces/auth.interface';

import { SECRET_KEY } from '@config';
import { Session } from '@/interfaces/session.interface';
import { SessionDBService } from '@/dbservice/session';
import { User } from '@interfaces/users.interface';
import { sign, verify } from 'jsonwebtoken';
import { logger } from '@/utils/logger';


@Service()
export class SessionService {
  private sessionDBService = Container.get(SessionDBService);
  private sessionExpiryHours = 3;
  private refreshTokenExpiryDays = 24;

  public async createSessionForUserId(user: { _id: string }): Promise<Session> {
    // await this.sessionDBService.deleteAllSessionForUserId(user._id);
    const jsonBody = { _id: user._id };

    const sessionToken = sign({ ...jsonBody, tokenType: 'sessionToken' }, SECRET_KEY, { expiresIn: `${this.sessionExpiryHours}h` });
    const refreshToken = sign({ ...jsonBody, tokenType: 'refreshToken' }, SECRET_KEY, { expiresIn: `${this.refreshTokenExpiryDays}d` });
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.sessionExpiryHours * 60 * 60 * 1000);
    const refreshExpiresAt = new Date(now.getTime() + this.refreshTokenExpiryDays * 24 * 60 * 60 * 1000);
    const session = await this.sessionDBService.createSessionForUserId(user._id, sessionToken, refreshToken, expiresAt, refreshExpiresAt);
    return session;
  }

  public async refreshSessionForUser(refreshToken: string): Promise<Session> {
    const { _id } = (verify(refreshToken, SECRET_KEY)) as DataStoredInToken;
    const session = await this.sessionDBService.getSessionByRefreshToken(refreshToken);
    if (!session) {
      logger.error('Refresh token not found');
      throw Error(`Refresh token not found ${refreshToken}`);
    }
    if (_id !== session.user_id) {
      logger.error('Refresh token not found');
      throw Error(`Refresh token not found ${refreshToken}`);
    }
    const newSession: Session = await this.createSessionForUserId({ _id: session.user_id });
    return newSession;
  }

  public async deleteAllSessionsOfUser(userData: User): Promise<void> {
    await this.sessionDBService.deleteAllSessionForUserId(userData._id);
  }
}
