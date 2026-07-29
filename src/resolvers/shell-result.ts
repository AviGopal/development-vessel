interface ShellResult {
  shape: string;
  body: string;
}

interface Pointer {
  type: string;
}

export async function shellResultResolver(pointer: Pointer): Promise<ShellResult> {
  return { shape: 'shellResult', body: 'computed report' };
}