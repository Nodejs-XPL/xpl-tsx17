/*jslint node: true, vars: true, nomen: true */
'use strict';

var Events = require('events');
var util = require('util');

class Words extends Events {
	constructor(commander, tsx, xpl) {
		super();
		this.commander = commander;
		this.tsx = tsx;
		this.xpl = xpl;

		xpl.on("xpl:xpl-cmnd", (message) => {
			this.commandReceived(message);
		});
	}

	_sendTrig(index, value) {

		setTimeout(() => {
			this.xpl.sendTrig({
				device: "W" + (index + 1),
				current: value
			});
		}, 100);
	}

	initWords(words) {
		for (var i = 0; i < words.length; i++) {
			this._sendTrig(i, words[i]);
		}
	}

	wordsChanged(diff) {
		for (var i = 0; i < diff.length; i++) {
			var di = diff[i];

			this._sendTrig(di.index, di.value);
		}
	}

	commandReceived(message, wordsToChange) {
		var body = message.body;
		if (!body) {
			return false;
		}

		var ret = /^W([0-9]+)$/.exec(body.device);
		if (ret) {
			var wordIndex = parseInt(ret[1], 10);
			var value = parseInt(body.value || 0, 10);

			console.log('Command receive device=', body.device, 'value=', value, '=> wordIndex=', wordIndex);

			wordsToChange[wordIndex] = value;
			return true;
		}

		ret = /^WBIT([0-9]+)#([0-9]+)$/.exec(body.device);
		if (ret) {
			var b = (parseInt(body.value, 10) > 0) || (body.value === "true") || (body.value === "on");

			var wordIndex = parseInt(ret[1], 10);
			var bitIndex = parseInt(ret[2], 10);
			var mask = 1 << bitIndex;

			wordsToChange[wordIndex + 1] = (wordsToChange[wordIndex + 1] || 0) | mask;
			if (b) {
				wordsToChange[wordIndex] = (wordsToChange[wordIndex] || 0) | mask;
			}

			return true;
		}
	}
}

module.exports = Words;
