import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { fleetSnapshot } from './fixtures';

export const server = setupServer(http.get('/api/apps', () => HttpResponse.json(fleetSnapshot())));
