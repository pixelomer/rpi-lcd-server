import express from "express";
import LCD from "lcd";
import util from "util";
import bodyParser from "body-parser";
import process, { config } from "process";
import fs from "fs";
import os from "os-utils";
//@ts-ignore
import vcgencmd from "../deps/node-vcgencmd";

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// Interfaces
interface ServiceDetails {
	timeout?: NodeJS.Timeout | null,
	value: string,
	name: string,
	date: Date,
	expireDate?: Date
};

// Constants
const STATS_TICK_INTERVAL = 5000;
const SCROLL_INTERVAL = 500;
const SERVICES_TICK_INTERVAL = 3000;

// Configuration
let HOST = "127.0.0.1";
let PORT = 8485;
let LCD_PINS = {
	data: [ 14, 15, 18, 23 ] as [number, number, number, number],
	rs: 24,
	e: 25
};

const configFile = process.argv[2] ?? null;
if (configFile != null) {
	const configData = JSON.parse(fs.readFileSync(configFile, "utf-8"));
	if (
		(configData.rs != null) ||
		(configData.e != null) ||
		(configData.data != null)
	) {
		if (
			(typeof configData.rs === 'number') &&
			(typeof configData.e === 'number') &&
			Array.isArray(configData.data) &&
			(configData.data.length === 4) &&
			configData.data.every((val) => typeof val === 'number')
		) {
			LCD_PINS = {
				"rs": configData.rs,
				"e": configData.e,
				"data": configData.data
			};
		}
		else {
			console.error("LCD configuration is invalid. Check your config file!");
			process.exit(1);
		}
	}
	if (typeof configData.host === 'string') {
		HOST = configData.host;
	}
	if (typeof configData.port === 'number') {
		PORT = configData.port;
	}
}

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json({ strict: true }));

let previousServiceIndex = -1;
const serviceNames: string[] = [];
const serviceDetails: Map<string, ServiceDetails> = new Map();
const route = "/v1/status/:service([a-zA-Z0-9\\-]{1,32})";

app.get(route, (request, response) => {
	const serviceName: string = request.params.service;
	const object = serviceDetails.get(serviceName);
	if (object == null) {
		response.status(404).send({ error: "No such service" });
		return;
	}
	response.status(200).send({
		value: object.value,
		lastUpdate: object.date,
		expireDate: object.expireDate ?? null
	});
});

app.get("/v1/services", (request, response) => {
	response.status(200).send({
		services: serviceNames,
		currentService: previousServiceIndex
	});
});

function setServiceTimeout(service: string, timeoutMs: number | null): boolean {
	const object = serviceDetails.get(service);
	if (object == null) {
		return false;
	}
	if (object.timeout != null) {
		clearTimeout(object.timeout);
	}
	if (timeoutMs != null) {
		object.timeout = setTimeout(() => {
			deleteService(object.name);
		}, timeoutMs);
		object.expireDate = new Date(Date.now() + timeoutMs);
	}
	else {
		object.timeout = null;
		object.expireDate = null;
	}
	return true;
}

function deleteService(serviceName: string): boolean {
	const index = serviceNames.indexOf(serviceName);
	if (index === -1) {
		return false;
	}
	if (previousServiceIndex >= index) {
		previousServiceIndex--;
	}
	serviceNames.splice(index, 1);
	setServiceTimeout(serviceName, null);
	serviceDetails.delete(serviceName);
	return true;
}

app.delete(route, (request, response) => {
	const serviceName: string = request.params.service;
	const didExist = deleteService(serviceName);
	if (!didExist) {
		response.status(404).send({ error: "No such service" });
		return;
	}
	response.status(200).send({});
});

app.put(route, (request, response) => {
	const serviceName: string = request.params.service;
	const serviceValue: string = request.body.value;
	if (typeof serviceValue !== 'string') {
		response.status(400).send({ error: "Value must be a string" });
		return;
	}
	else if (serviceValue.length > 100) {
		response.status(400).send({ error: "Value string too long" });
		return;
	}
	if (serviceNames.indexOf(serviceName) === -1) {
		serviceNames.push(serviceName);
		serviceDetails.set(serviceName, {
			name: serviceName,
			value: serviceValue,
			date: new Date()
		});
		if (previousServiceIndex === -1) {
			previousServiceIndex = 0;
		}
	}
	else {
		const object = serviceDetails.get(serviceName);
		object.value = serviceValue;
		object.date = new Date();
	}
	const expireMs = parseInt(request.body.expire);
	setServiceTimeout(serviceName, Number.isInteger(expireMs) ? expireMs : null);
	response.status(200).send({});
});

const lcd = new LCD({
	...LCD_PINS,
	cols: 16,
	rows: 2
});

const printLCD_unlocked: (str: string) => Promise<void> = util.promisify(lcd.print.bind(lcd));
const printQueue: ((val?) => void)[] = [];
let isPrinting = false;
async function printLCD(column: number, row: number, str: string) {
	if (isPrinting) {
		await new Promise((resolve) => printQueue.push(resolve));
	}
	isPrinting = true;
	lcd.setCursor(column, row);
	await printLCD_unlocked(str);
	if (printQueue.length !== 0) {
		const resolve = printQueue.splice(0, 1)[0];
		resolve();
	}
	isPrinting = false;
}

lcd.on("ready", async() => {
	await util.promisify(lcd.clear.bind(lcd))();

	setInterval(async() => {
		const temperatureStr = `${Math.floor(vcgencmd.measureTemp() * 10) / 10}\xDFC`;
		const cpuUsage = await new Promise<number>((resolve) => os.cpuUsage(resolve));
		const cpuStr = `${Math.floor(cpuUsage * os.cpuCount() * 1000) / 10}%`;
		const str = `${temperatureStr.padEnd(16-cpuStr.length, " ")}${cpuStr}`;
		await printLCD(0, 1, str);
	}, STATS_TICK_INTERVAL);

	async function onServicesTick() {
		if (previousServiceIndex === -1) {
			await printLCD(0, 0, " ".repeat(16));
		}
		else {
			previousServiceIndex++;
			if (previousServiceIndex >= serviceNames.length) {
				previousServiceIndex = 0;
			}
			const name = serviceNames[previousServiceIndex];
			const object = serviceDetails.get(name);
			const value = object.value;
			await printLCD(0, 0, value.substr(0, 16).padEnd(16, " "));
			if (value.length > 16) {
				await sleep(SCROLL_INTERVAL * 3);
				for (let offset = 0; offset <= value.length - 16; offset++) {
					await printLCD(0, 0, value.substr(offset, 16));
					await sleep(SCROLL_INTERVAL);
				}
			}
		}
		setTimeout(onServicesTick, SERVICES_TICK_INTERVAL);
	}
	setTimeout(onServicesTick, SERVICES_TICK_INTERVAL);
});

process.on('SIGINT', () => {
	lcd.close();
	process.exit();
});

process.on("uncaughtException", (err) => {
	lcd.close();
	console.log(err);
	process.exit(1);
});

app.listen(PORT, HOST, () => {
	console.log(`Listening on http://${HOST}:${PORT}`);
});