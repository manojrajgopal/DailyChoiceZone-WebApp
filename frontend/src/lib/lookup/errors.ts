import { ApiError } from "@/services/api/client";

/**
 * What to say when a lookup fails — in the entity's own words, and never a
 * server's internals. The backend's 404/422 messages are already written for
 * people ("Product ID PRD999 was not found.", "Invalid Order ID…") and are used
 * as they come; everything else gets a sentence of our own.
 */
export function lookupErrorMessage(error: unknown, { idLabel, id }: { idLabel: string; id?: string }): string {
  if (!(error instanceof ApiError)) return "Something went wrong looking that ID up. Please try again.";

  switch (error.code) {
    case "TIMEOUT":
    case "NETWORK_ERROR":
      return error.message;
    default:
      break;
  }

  const entity = idLabel.replace(/ ID$/, "").toLowerCase();
  switch (error.status) {
    case 400:
    case 422:
      return error.message || `Invalid ${idLabel}.`;
    case 401:
      return "Your session has ended. Sign in again to look IDs up.";
    case 403:
      return `You don't have access to ${entity} records.`;
    case 404:
      if (error.code === "LOOKUP_NOT_FOUND" && error.message) return error.message;
      return id ? `${idLabel} ${id} was not found.` : `That ${idLabel} was not found.`;
    case 409:
      return "That record changed while it was loading. Please try again.";
    case 429:
      return "That's a lot of lookups in a short time. Please wait a moment and try again.";
    default:
      return "Something went wrong looking that ID up. Please try again.";
  }
}
