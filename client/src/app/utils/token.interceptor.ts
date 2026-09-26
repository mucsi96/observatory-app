import { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { AuthService } from '../auth.service';
import { isApiRequest } from './api-request';

export const tokenInterceptor: HttpInterceptorFn = (req, next) => {
  const token = inject(AuthService).getAccessToken();
  return next(
    isApiRequest(req.url) && token
      ? req.clone({ setHeaders: { Authorization: `Bearer ${token}` } })
      : req
  );
};
