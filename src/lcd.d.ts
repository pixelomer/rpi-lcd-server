
declare module 'lcd' {
	import { EventEmitter } from 'events';
	export default class Lcd extends EventEmitter {
		constructor(configuration: {
			rs: number,
			e: number,
			data: [number, number, number, number],

			/** @default 16 */
			cols?: number,

			/** @default 1 */
			rows?: number,

			/** @default false */
			largeFont?: boolean
		});
		print(val: any, cb?: (err: Error, str: string) => void): void;
		clear(cb?: (err: Error) => void): void;
		home(cb?: (err: Error) => void): void;
		setCursor(col: number, row: number): void;
		cursor(): void;
		noCursor(): void;
		blink(): void;
		noBlink(): void;
		scrollDisplayLeft(): void;
		scrollDisplayRight(): void;
		leftToRight(): void;
		rightToLeft(): void;
		autoscroll(): void;
		noAutoscroll(): void;
		close(): void;
	}
}