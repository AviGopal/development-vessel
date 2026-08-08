/**
 * code_read_lines - A bridge resolver that invokes the local-tools-vessel code_read_lines capability
 * to read specific lines from a file.
 * 
 * This resolver acts as a bridge to the deterministic code_read_lines resolver in local-tools-vessel,
 * allowing activities to invoke it directly.
 */

import type { ResolverResult } from "./types.js";

interface CodeReadLinesPointer {
  path: string;
  start_line: number;
  end_line: number;
}

export async function resolveCodeReadLines(pointer: CodeReadLinesPointer): Promise<ResolverResult> {
  const { path, start_line, end_line } = pointer;
  
  if (!path || typeof start_line !== 'number' || typeof end_line !== 'number') {
    return {
      shape: "structuredError",
      body: {
        error: "path, start_line, and end_line are required",
        path,
        start_line,
        end_line
      }
    };
  }
  
  if (start_line < 1 || end_line < start_line) {
    return {
      shape: "structuredError",
      body: {
        error: "start_line and end_line must be positive integers with end_line >= start_line",
        start_line,
        end_line
      }
    };
  }

  try {
    // Call the local-tools-vessel code_read_lines resolver via discovery
    const discoveryEndpoint = process.env.DISCOVERY_ENDPOINT ?? "http://127.0.0.1:8100";
    const apiKey = process.env.METABOB_API_KEY ?? "";
    
    const response = await fetch(`${discoveryEndpoint}/resolve`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `ApiKey ${apiKey}`
      },
      body: JSON.stringify({
        pointer: {
          type: "code_read_lines",
          path,
          start_line,
          end_line
        }
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      return {
        shape: "structuredError",
        body: {
          error: `Failed to invoke code_read_lines resolver`,
          status: response.status,
          ...errorData
        }
      };
    }

    const result = await response.json();
    
    // The local-tools-vessel returns { shape: "codeReadResult", ... }
    // We need to wrap it appropriately for the substrate
    if (result?.shape === "codeReadResult") {
      return {
        shape: "codeReadResult",
        body: result
      };
    }
    
    // If the response has a content field, extract it
    if (result?.content) {
      return {
        shape: "codeReadResult",
        body: result.content
      };
    }
    
    return {
      shape: "codeReadResult",
      body: result
    };
  } catch (error) {
    return {
      shape: "structuredError",
      body: {
        error: (error as Error).message,
        path,
        start_line,
        end_line
      }
    };
  }
}
