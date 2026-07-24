// Web-build stand-in for '@/services/users' (aliased by vite --mode web):
// multi-profile switching against the local SQLite engine in the worker.
import { remoteService } from '@/services/web/worker-client'
import type { UsersServiceContract } from '@/services/contract'

export const UsersService = remoteService<UsersServiceContract>('users')

export type { User, UserResult } from '@/services/contract'
