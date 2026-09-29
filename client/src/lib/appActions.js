import { createContext, useContext } from "react";

/* What a card deep in the thread can ask the app to do -- open a code project
 * a tool just made -- without threading a callback through every list and
 * message between here and there. */
export const AppActions = createContext({ openCodeFolder: null });

export const useAppActions = () => useContext(AppActions);
