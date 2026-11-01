import { HttpInterceptorFn } from '@angular/common/http';

/**
 * Automatically attaches the cryptographically signed Bearer token to all outgoing HTTP requests.
 * Reads the token from the active session.
 */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  try {
    const raw = sessionStorage.getItem('orion.user');
    if (raw) {
      const user = JSON.parse(raw);
      if (user?.token) {
        const cloned = req.clone({
          setHeaders: {
            Authorization: `Bearer ${user.token}`,
          },
        });
        return next(cloned);
      }
    }
  } catch {
    // If sessionStorage or parsing fails, continue request without header
  }
  return next(req);
};
