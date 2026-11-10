declare module '*.csv?raw' {
  const content: string;
  export default content;
}

declare module 'html5-qrcode' {
  export class Html5Qrcode {
    constructor(elementId: string);
    start(
      camera: { facingMode: string },
      config: { fps: number; qrbox: { width: number; height: number } },
      onScan: (text: string) => void,
      onError: (error: string) => void,
    ): Promise<void>;
    pause(pauseVideo?: boolean): void;
    resume(): void;
  }
}
