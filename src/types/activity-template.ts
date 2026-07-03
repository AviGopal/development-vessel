export interface FsListTask {
  id: string;
  type: 'fs_list';
  glob: string;
  shuffle: boolean;
  output_variable: string;
}

export interface JsonPathExtractTask {
  id: string;
  type: 'json_path_extract';
  input_variable: string;
  path: string;
  output_variable: string;
}

export interface LlmCompletionDispatchTask {
  id: string;
  type: 'llm_completion_dispatch';
  prompt_template: string;
  input_variables: string[];
  output_variable: string;
}

export interface HttpFetchTask {
  id: string;
  type: 'http_fetch';
  method: string;
  url: string;
  body: Record<string, unknown>;
  output_variable: string;
}

export type ActivityTask =
  | FsListTask
  | JsonPathExtractTask
  | LlmCompletionDispatchTask
  | HttpFetchTask;

export interface ActivityTemplate {
  id: string;
  tags: string[];
  boredom_target_template: boolean;
  description: string;
  tasks: ActivityTask[];
}
