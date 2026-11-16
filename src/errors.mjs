export class ContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ContractError";
    this.code = code;
  }
}

export class GitHubApiError extends Error {
  constructor(status, method, route) {
    super(`GitHub API ${method} ${route} failed with HTTP ${status}.`);
    this.name = "GitHubApiError";
    this.status = status;
    this.method = method;
    this.route = route;
  }
}

export function invariant(condition, code, message) {
  if (!condition) throw new ContractError(code, message);
}
