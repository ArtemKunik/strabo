import { createStraboRouter } from './router.ts';
import type { StraboConfig } from '../types.ts';

export interface DispatchResult {
  status: number;
  body: unknown;
}

export type ApiDispatch = (
  method: string,
  path: string,
  query?: Record<string, string>,
) => Promise<DispatchResult>;

export function createApiDispatch(config: StraboConfig): ApiDispatch {
  const router = createStraboRouter(config);

  return (method, path, query = {}) =>
    new Promise<DispatchResult>((resolve, reject) => {
      const [pathname = path, search = ''] = path.split('?');
      const parsedQuery: Record<string, string> = {};
      for (const [key, value] of new URLSearchParams(search)) {
        parsedQuery[key] = value;
      }
      let settled = false;
      const finish = (status: number, body: unknown): void => {
        if (!settled) {
          settled = true;
          resolve({ status, body });
        }
      };

      const request = {
        method: method.toUpperCase(),
        url: path,
        originalUrl: path,
        baseUrl: '',
        path: pathname,
        query: { ...parsedQuery, ...query },
        params: {},
        body: undefined,
        headers: {},
        get: () => undefined,
        header: () => undefined,
        accepts: () => false,
        is: () => false,
      };

      const response = {
        statusCode: 200,
        headersSent: false,
        setHeader: () => undefined,
        getHeader: () => undefined,
        removeHeader: () => undefined,
        set: () => response,
        get: () => undefined,
        type: () => response,
        status(code: number) {
          response.statusCode = code;
          return response;
        },
        json(body: unknown) {
          finish(response.statusCode, body);
          return response;
        },
        send(body: unknown) {
          finish(response.statusCode, body);
          return response;
        },
        end() {
          finish(response.statusCode, undefined);
        },
      };

      const next = (error?: unknown): void => {
        if (error) {
          reject(error);
          return;
        }
        finish(404, { error: 'Not found' });
      };

      try {
        (router as unknown as (req: unknown, res: unknown, next: unknown) => void)(
          request,
          response,
          next,
        );
      } catch (error) {
        reject(error);
      }
    });
}
