export interface RubricEchoPointer {
  type: 'rubricEcho';
  text: string;
}

export interface RubricEchoResponse {
  shape: 'rubricEcho';
  body: {
    original: string;
    reversed: string;
  };
}

export function resolveRubricEcho(pointer: RubricEchoPointer): RubricEchoResponse {
  return {
    shape: 'rubricEcho',
    body: {
      original: pointer.text,
      reversed: pointer.text.split('').reverse().join(''),
    },
  };
}
