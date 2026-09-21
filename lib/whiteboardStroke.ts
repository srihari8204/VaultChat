export const CANVAS_BG = '#FFFFFF';
export const DEFAULT_INK = '#111827';

export type Tool = 'pen' | 'eraser';
export type Point = { x: number; y: number };
export type PathData = { points: Point[]; color: string; width: number };

export function commitWhiteboardPath(points: Point[], tool: Tool, color: string, brushSize: number): PathData | null {
  if (points.length < 2) return null;
  return {
    points,
    color: tool === 'eraser' ? CANVAS_BG : color,
    width: tool === 'eraser' ? brushSize * 3 : brushSize,
  };
}
