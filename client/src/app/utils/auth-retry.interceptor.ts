import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, from, NEVER, switchMap, throwError } from 'rxjs';
import { AuthService } from '../auth.service';
import { isApiRequest } from './api-request';

export const authRetryInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);
  return next(req).pipe(
    catchError((error: unknown) => {
      if (
        !(error instanceof HttpErrorResponse) ||
        error.status !== 401 ||
        !isApiRequest(req.url)
      )
        return throwError(() => error);
      return from(auth.refresh('http-401')).pipe(
        catchError((refreshError) =>
          auth.reauthenticateAfterRefreshFailure(refreshError)
            ? NEVER
            : throwError(() => error)
        ),
        switchMap(() => next(req))
      );
    })
  );
};
