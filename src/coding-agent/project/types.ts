export interface ProjectInfo {
  readonly id: string;
  readonly name: string;
  readonly directories: readonly string[];
  readonly primaryDirectory: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface UpdateProjectInput {
  readonly name?: string;
  readonly directories?: readonly string[];
  readonly primaryDirectory?: string;
}

export interface OpenProjectInput {
  readonly keaHome: string;
  readonly directory?: string;
  readonly cwd?: string;
}

export interface OpenedProject {
  readonly info: ProjectInfo;
  readonly storageDir: string;
  readonly initialCwd: string;
}
