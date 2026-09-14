import { RunTree } from 'langsmith/run_trees';
import { withRunTree } from 'langsmith/traceable';

/** Explicit scope prevents inherited LangSmith tracing from exporting work data. */
export function withoutTracing<T>(operation: () => Promise<T>): Promise<T> {
  return withRunTree(new RunTree({ name: 'ytriple-local', inputs: {}, tracingEnabled: false }), operation);
}
