export type InitStep = { phase: "agent_waiting" } | { phase: "done" };

export type DesktopReadyData = {
  transport: "stdio";
  cwd: string;
  agentReady: boolean;
};

export type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export type InitState = {
  step: InitStep;
  waiters: Set<(value: DesktopReadyData) => void>;
};

export type LogFn = (message: string) => void;
