import { NextFunction, Request, Response } from 'express';

import { AuthService } from '@services/auth.service';
import { Container } from 'typedi';
import { TokenExpiredError } from 'jsonwebtoken';
import { GoogleLoginBodyWithLanguage, GoogleLoginRequest, RefreshTokenRequest, RequestWithUser } from '@interfaces/auth.interface';
import { User } from '@interfaces/users.interface';
import { getGoogleUserInfo, getGoogleUserInfoFromCode } from '@/external/googleapis';
import { UserService } from '@/services/users.service';
import { UserProfileModel } from '@/models/user_profile.model';
import { logger } from '@/utils/logger';
import { Auth } from 'googleapis';

export class AuthController {
  public authService = Container.get(AuthService);
  public userService = Container.get(UserService);

  public signUp = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userData: User = req.body;
      const signUpUserData: User = await this.authService.signupwithemail(userData.email);
      return res.status(201).json({ data: signUpUserData, message: 'signup' });
    } catch (error) {
      next(error);
    }
  };

  public logIn = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userData: User = req.body;
      const { user } = await this.authService.login(userData);
      return res.status(200).json({ data: user, message: 'login' });
    } catch (error) {
      next(error);
    }
  };

  public refreshToken = async (req: RefreshTokenRequest, res: Response, next: NextFunction) => {
    try {
      const { refresh_token } = req.body;
      const { sessionToken, refreshToken: newRefreshToken } = await this.authService.refreshToken(refresh_token);
      return res.status(200).json({
        data: {
          sessionToken,
          refreshToken: newRefreshToken
        }, message: 'refresh_token'
      });
    } catch (error) {
      if (error instanceof TokenExpiredError) {
        return res.status(401).json({ data: error, message: 'Token expired' });
      }
      return res.status(401).json({ data: error, message: 'Invalid refresh token' });
    }
  }

  public logOut = async (req: RequestWithUser, res: Response, next: NextFunction) => {
    try {
      const userData: User = req.user;
      await this.authService.logout(userData);
      return res.status(200).json({
        data: {
          sessionToken: null,
          refreshToken: null
        }, message: 'logout'
      });
    } catch (error) {
      next(error);
    }
  };

  public me = async (req: RequestWithUser, res: Response, next: NextFunction) => {
    try {
      const userData: User = req.user;
      const userProfile = await this.userService.getUserProfile(userData._id);
      return res.status(200).json({
        data: {
          ...userProfile,
          email: userData.email,
          _id: userData._id,
        }, message: 'user_info'
      });
    } catch (error) {
      next(error);
    }
  };

  public googleLogin = async (req: GoogleLoginRequest, res: Response, next: NextFunction) => {
    try {
      const body: GoogleLoginBodyWithLanguage = req.body;
      let googleUser: Auth.TokenPayload;
      const language = body.language || 'en';
      logger.debug(`Google login request: ${JSON.stringify(body)}`);
      if (body.code) {
        googleUser = await getGoogleUserInfoFromCode(body.code, body.redirect_uri);
      } else {
        googleUser = await getGoogleUserInfo(body);
      }
      const email = googleUser.email;
      const picture = googleUser.picture;
      // Check if user exists
      let user = await this.userService.findUserByEmail(email);
      if (!user) {
        user = await this.userService.createUserFromGoogle(googleUser);
      }
      const avatar = await this.userService.fetchAvatarFromURL(picture);
      await UserProfileModel.updateOne({
        user_id: user._id,
      }, {
        $set: {
          first_name: googleUser.given_name,
          last_name: googleUser.family_name,
          avatar: avatar,
          language: language
        }
      })
      await this.userService.clearUserProfileCache(user._id);
      const updatedUserProfile = await this.userService.getUserProfile(user._id);
      const { sessionToken, refreshToken, user: loggedInUser } = await this.authService.login(user);
      user = {
        ...updatedUserProfile,
        ...loggedInUser,
        email: user.email
      }
      return res.status(200).json({ data: { user, sessionToken, refreshToken }, message: 'login' });
    } catch (error) {
      next(error);
    }
  }

}
