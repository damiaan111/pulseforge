// What this project uses of Butterchurn, which ships no types.
declare module 'butterchurn' {
  interface Visualizer {
    loadPreset(preset: unknown, blendTime: number): void;
    render(options: {
      readonly audioLevels: { readonly timeByteArray: Uint8Array; readonly timeByteArrayL: Uint8Array; readonly timeByteArrayR: Uint8Array };
      readonly elapsedTime: number;
    }): void;
  }
  const butterchurn: {
    createVisualizer(context: BaseAudioContext, canvas: HTMLCanvasElement, options: { width: number; height: number; pixelRatio: number; textureRatio: number }): Visualizer;
  };
  // eslint-disable-next-line no-restricted-syntax -- the shape of a package this project does not own.
  export default butterchurn;
}
