import { createContext } from "react";
/** Event predicates represented at a chart point. A multi-query formula can involve several event sets. */
export const ChartAudience = createContext<Record<string, unknown>[]>([{}]);
