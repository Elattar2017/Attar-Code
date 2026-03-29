import { authenticate } from './auth';
import { createUser } from './db';
export function handleRequest() {
  const user = authenticate("token");
  console.log(user.phone);
  const newUser = createUser("Test", "test@test.com", "555-1234");
}
