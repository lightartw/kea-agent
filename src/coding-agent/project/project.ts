import { isAbsolute, resolve } from "node:path";

/** One durable Project record: identity plus the normalized Project directory. */
export interface ProjectInfo {
  readonly id: string;
  readonly name: string;
  readonly directory: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export class ProjectError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProjectError";
  }
}

/** Strict UUID shape shared by Project ID scanning, validation, and path derivation. */
export const PROJECT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

const UTC_ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function isUtcTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !UTC_ISO_PATTERN.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

/** Shared field validation for ProjectInfo values from any source. */
export function validateProjectInfo(info: ProjectInfo): void {
  if (!PROJECT_ID_PATTERN.test(info.id)) {
    throw new ProjectError(`Project ID is invalid: ${info.id}`);
  }
  if (typeof info.name !== "string" || info.name.trim() === "") {
    throw new ProjectError("Project name must be a non-empty string");
  }
  if (
    typeof info.directory !== "string"
    || !isAbsolute(info.directory)
    || resolve(info.directory) !== info.directory
  ) {
    throw new ProjectError(`Project directory must be absolute and normalized: ${info.directory}`);
  }
  if (!isUtcTimestamp(info.createdAt)) {
    throw new ProjectError(`Project createdAt is not a valid UTC timestamp: ${info.createdAt}`);
  }
  if (!isUtcTimestamp(info.updatedAt)) {
    throw new ProjectError(`Project updatedAt is not a valid UTC timestamp: ${info.updatedAt}`);
  }
}
