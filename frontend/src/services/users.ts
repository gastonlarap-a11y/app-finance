// Wrapper around the generated UsersService bindings (finance profiles). Switching
// user only changes the active id on the backend; the SQLite connection is shared,
// so the UI just refetches (bump refreshAtom) after a switch.
export {
  UsersService,
  User,
  UserResult,
} from '@/../bindings/github.com/gastonlarap-a11y/app-finance/backend/users'
