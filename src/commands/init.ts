import { render } from "ink";
import React from "react";
import { App } from "../ui/App.js";

export async function runInit(args: { cwd: string }): Promise<void> {
  const { waitUntilExit } = render(React.createElement(App, { cwd: args.cwd }));
  await waitUntilExit();
}
