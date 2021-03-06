/*jslint node: true, vars: true, nomen: true */
'use strict';

var Xpl = require("xpl-api");
var commander = require('commander');
var Serialport = require("serialport");
var TSX17 = require('tsx17');
var os = require('os');
var debug = require('debug')('xpl-tsx17');

var processor;

commander.version(require("./package.json").version);
commander.option("-s, --serialPort <path>", "Serial device path");
commander.option("--wordCount <count>", "Word count to scan", parseInt);
commander.option("--model <path>", "Model filename (optional)");

Xpl.fillCommander(commander);

commander.option("--heapDump", "Enable heap dump (require heapdump)");

commander.command('listSerialPort').description("List serial ports").action(() => {

	console.log("List serial ports:");
	serialport.list((err, ports) => {
		if (err) {
			console.log("List performs error : " + err);
			process.exit(0);
			return;
		}

		ports.forEach(function (port) {
			console.log("  Port name='" + port.comName + "' pnpId='" +
				port.pnpId + "' manufacturer='" + port.manufacturer + "'");
		});
		console.log("End of list");
	});
});

function changeWords(protocol, ws, callback) {

	if (!ws.length) {
		return callback();
	}

	debug("Changed words=", ws);

	var start = 0;
	for (; start < ws.length && ws[start] === undefined; start++) {
	}
	var end = start;
	for (; end < ws.length && ws[end] !== undefined; end++) {
	}

	if (start === end) {
		return callback();
	}

	if (start === end - 1) {
		var v = ws[start];
		delete ws[start];

		debug("SetWord offset=", start, " value=", v, " ws=", ws);

		protocol.setWord(v, start, callback);
		return;
	}

	var nv = ws.slice(start, end);
	for (var i = start; i < end; i++) {
		delete ws[i];
	}

	debug("SetWords offset=", start, " values=", nv, " ws=", ws);

	protocol.setWords(nv, start, nv.length, callback);
}

commander.command('start').description("Start processing TSX17 datas").action(() => {
	console.log("Start");

	if (!commander.serialPort) {
		switch (os.platform()) {
			case "win32":
				commander.serialPort = "COM4";
				break;
			case "linux":
				commander.serialPort = "/dev/serial/by-path/pci-0000:00:14.0-usb-0:1:1.0-port0";
				break;
		}

		console.log("Use default serial port : " + commander.serialPort);
	}

	var lastWordsDate = -1;
	var lastWatchdogDate = -1;
	setInterval(() => {
		if (lastWatchdogDate < 0) {
			lastWatchdogDate = lastWordsDate;
			return
		}
		var now = Date.now();
		if (lastWatchdogDate < lastWordsDate) {
			lastWatchdogDate = now;
			return;
		}
		console.error("Watchdog detection ! no data");
		process.exit(1);

	}, 1000 * 30);

	var tsx = new TSX17.Serial(commander.serialPort, (error, tsx) => {
		if (error) {
			console.log("Can not instanciate tsx ", error);
			process.exit(1);
			return;
		}

		console.log("Before open");

		tsx.open((error) => {
			if (error) {
				console.log("Can not open tsx ", error);
				process.exit(1);
				return;
			}

			console.log("Serial device '" + commander.serialPort + "' opened.");

			var protocol = new TSX17.Protocol(tsx);

			if (!commander.xplSource) {
				var hostName = os.hostname();
				if (hostName.indexOf('.') > 0) {
					hostName = hostName.substring(0, hostName.indexOf('.'));
				}

				commander.xplSource = "tsx17." + hostName;
			}

			var xpl = new Xpl(commander);

			xpl.on("error", (error) => {
				console.error("XPL error", error);
			});

			xpl.bind((error) => {
				if (error) {
					console.log("Can not open xpl bridge ", error);
					process.exit(2);
					return;
				}

				console.log("Xpl bind succeed ");

				var processorClass;
				var model;
				if (commander.model) {
					model = require(commander.model);

					processorClass = require('./lib/model');
				}

				if (!processorClass) {
					processorClass = require('./lib/words');
				}

				var wordsToChange = [];

				var processor = new processorClass(commander, tsx, xpl, model, wordsToChange);

				var previousWords = null;

				function poolWords() {

					changeWords(protocol, wordsToChange, (error) => {
						if (error) {
							console.error(error);
						}

						protocol.readWords(0, commander.wordCount || 15, (error, words) => {
							if (error) {
								console.error(error);
								return;
							}

							lastWordsDate = Date.now();

							var diff = null;
							if (previousWords) {
								var len = Math.min(previousWords.length, words.length);

								for (var i = 0; i < len; i++) {
									if (words[i] === previousWords[i]) {
										continue;
									}
									debug("Word changed: index=", i, "value=", words[i]);

									if (!diff) {
										diff = [];
									}
									diff.push({
										index: i,
										trig: (previousWords[i] !== undefined),
										value: words[i]
									});
								}
							}

							debug("Emit words event", words, diff);

							processor.emit('words', words, diff, previousWords);

							previousWords = words;

							setTimeout(poolWords, 10);
						});
					});
				}

				poolWords();
			});
		});
	});
});

commander.command('test').action(() => {
	var model = require(commander.model);

	var processorClass = require('./lib/model');
	var tsx = null;
	var xpl = null;

	var processor = new processorClass(commander, tsx, xpl, model);

});

commander.parse(process.argv);

if (commander.heapDump) {
//	var heapdump = require("heapdump");
	console.log("***** HEAPDUMP enabled **************");
}
