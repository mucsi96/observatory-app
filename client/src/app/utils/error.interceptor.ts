import { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { NotificationsService } from '@mucsi96/angular-material-theme';
import { catchError, throwError } from 'rxjs';

export const errorInterceptor: HttpInterceptorFn = (req, next) => {
  const notifications = inject(NotificationsService);
  return next(req).pipe(
    catchError((error) => {
      notifications.error(
        error.status === 403
          ? 'Your account needs the readApps role to view Observatory.'
          : 'Could not update fleet signals. Please retry.'
      );
      return throwError(() => error);
    })
  );
};
