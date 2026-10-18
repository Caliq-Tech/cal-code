import { cmd } from "../cli/cmd/cmd"
import { clearKey } from "./session"

export const LogoutCommand = cmd({
  command: "logout",
  describe: "forget the stored calcode secret key",
  handler: async () => {
    await clearKey()
    console.log("Secret key removed. You will be asked for it on next run.")
  },
})
