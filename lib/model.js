/*jslint node: true, vars: true, nomen: true */
'use strict';

var async = require('async');
var jsep = require('jsep');
var Events = require('events');
var util = require('util');
var debug = require('debug')('xpl-tsx17:model');

var transactionId = 1;

class Model extends Events {
	constructor(commander, tsx, xpl, model, wordsToChange) {
		super();

		this.commander = commander;
		this.xpl = xpl;
		this.wordsToChange = wordsToChange;
		this.model = model;

		this.setMaxListeners(128);

		jsep.addBinaryOp('=', 12);
		jsep.addBinaryOp('#', 15);

		var units = model.units;

		units.forEach((unit) => {
			var status = unit.status;

			if (typeof (status) === "string") {
				this._addListener(unit, "status", status);

			} else {
				for (var k in status) {
					this._addListener(unit, k, status[k]);
				}
			}

			var commands = unit.command;
			if (commands) {
				var keys = Object.keys(commands);

				debug("Process keys", keys);

				keys.forEach((k) => {
					if (k.indexOf('|') < 0) {
						return;
					}

					var v = commands[k];
					k.split("|").forEach((n) => {
						commands[n] = v;
					});

					delete commands[k];
				});
			}
			// console.error("Unknown type of status", status);
		});

		xpl.on("xpl:xpl-cmnd", (message) => {
			this.commandReceived(message);
		});

		this.once('words', (words) => {
			debug("Init words ", words);
			var ti = transactionId++;

			var ws = {};
			for (var j = 0; j < words.length; j++) {
				ws["W" + j] = words[j];
			}

			for (var i = 0; i < words.length; i++) {
				this.emit("W" + i, ws, ti, true);
			}
		});

		this.on('words', (words, diff, previousWords) => {
			if (!diff || !diff.length) {
				return;
			}

			var ti = transactionId++;

			var ws = {};
			for (var j = 0; j < words.length; j++) {
				var w = words[j];
				ws["W" + j] = w;
			}

			for (var i = 0; i < diff.length; i++) {
				var di = diff[i];

				debug("Emit change of #" + di.index + " " + di.value);

				this.emit("W" + di.index, ws, ti);
			}
		});
	}

	_requestStatus(device) {
		var units = this.model.units;

		this.once('words', (words, diff) => {

			var wordsByName = {};
			for (var j = 0; j < words.length; j++) {
				wordsByName["W" + j] = words[j];
			}

			debug("Returns request status", wordsByName);

			async.eachSeries(units, (unit, callback) => {

				async.forEachOfSeries(unit.$trees, (tree, statusName, callback) => {

					debug("Unit ", unit, " status=", statusName);

					this._sendUnitStatus(unit, statusName, wordsByName, false, callback, true);
				}, callback);

			}, (error) => {
				console.error(error);
			});
		});
	}

	commandReceived(message) {
		var body = message.body;

		if (!body) {
			debug("No body message=", message);
			return;
		}

		debug("Received message", message);

		/*
		 * xpl-cmnd { hop=1 source=xpl-xplhal.myhouse target=acme-tempsens.garage }
		 * sensor.request { command=status }
		 */

		if (message.bodyName === "sensor.request") {
			if (body.command === "request") {
				this._requestStatus(body.device || "*");
				return;
			}
		}

		var device = body.device;
		var command = body.command;
		var current = body.current;

		var unit;
		var units = this.model.units;
		for (var i = 0; i < units.length; i++) {
			var u = units[i];

			if (u.device === device) {
				unit = u;
				break;
			}
		}

		if (!unit) {
			debug("Can not find device '" + device + "'", body);
			return;
		}

		var commands = unit.command;
		if (!commands) {
			debug("No commands for device '" + device + "'", body);
			return;
		}

		var expression = commands[command];
		if (!expression) {
			if (current !== undefined) {
				expression = commands[command + "(current=" + current + ")"];
				if (!expression) {
					switch (current) {
						case 'off':
						case 'disabled':
						case '0':
						case 'false':
							current = 'disable';
							break;
						case 'on':
						case 'enabled':
						case '1':
						case 'true':
							current = 'enable';
							break;
					}
					expression = commands[command + "(current=" + current + ")"];
				}
			}
		}

		if (!expression) {
			debug("Command '" + command + "' is not found for device '" + device + "' body=", body, "commands=", commands);
			return;
		}

		if (unit.units === "%" && unit['0%'] !== undefined && unit['100%'] !== undefined) {
			current = parseFloat(current);
			if (!isNaN(current)) {
				current = Math.floor((current / 100) * (unit['100%'] - unit['0%']) + unit['0%']);
			} else {
				// debug("Current is invalid for command '" + command + "' and device '" +
				// device + "'", body);
				current = "";
			}
		}

		var context = {
			current: current,
			'$current': current
		};

		if (typeof (expression) === "string") {
			execute(this.wordsToChange, body, expression, context);
			return;
		}

		if (util.isArray(expression)) {
			for (var j = 0; j < expression.length; j++) {
				execute(this.wordsToChange, body, expression[j], context);
			}
			return;
		}
	}

	_addListener(unit, statusName, expression) {
		var tree = jsep(expression);
		tree.$expression = expression;

		if (!unit.$trees) {
			unit.$trees = {};
		}
		unit.$trees[statusName] = tree;

		var list = listIdentifiers([], tree);

		debug("Expression", expression, ": register identifiers :", list);

		list.forEach((identifier) => {
			debug("Add listener " + identifier + " " + unit.device + "/" + statusName);
			this.on(identifier, this._createListener(unit, statusName, expression));
		});
	}

	_sendUnitStatus(unit, statusName, wordsByName, testIfSame, callback, initPhase) {

		var tree = unit.$trees[statusName];

		var val = evalExpression(tree, wordsByName);

		debug("Exp", tree.$expression, /* wordsByName, */" =>", val);

		if (!unit._values) {
			unit._values = {};
		}

		var previous = unit._values[statusName];
		if (unit.overflow) {
			for (; previous > val;) {
				val += unit.overflow;
			}
		}

		if (testIfSame) {
			if (previous === val) {
				return callback && callback();
			}
		}
		unit._values[statusName] = val;

		var trig = {
			device: unit.device,
			type: statusName,
		};

		if (unit.units === "%" && unit['0%'] !== undefined && unit['100%'] !== undefined) {
			val = Math.floor((val - unit['0%']) * 100 / (unit['100%'] - unit['0%']));
		}
		if (typeof (unit.multiplier) === "number") {
			val = val * unit.multiplier;
		}

		trig.current = val;

		if (unit.units) {
			trig.units = unit.units;
		}

		if (initPhase) {
			debug("Send stat", trig);
			this.xpl.sendXplStat(trig, null, null, callback);
			return;
		}

		debug("Send trig", trig);
		this.xpl.sendXplTrig(trig, null, null, callback);
	}

	_createListener(unit, statusName) {
		return (wordsByName, transactionId, initPhase) => {
			var tree = unit.$trees[statusName];

			if (tree.$transactionId === transactionId) {
				return;
			}
			tree.$transactionId = transactionId;

			this._sendUnitStatus(unit, statusName, wordsByName, true, null, initPhase);
		};
	}
}

function listIdentifiers(list, node) {
	if (node.type === 'Identifier') {
		list.push(node.name);
		return list;
	}

	for (var k in node) {
		var n = node[k];

		if (typeof (n) === "object") {
			listIdentifiers(list, n);
		}
	}

	return list;
}

function evalExpression(node, context) {
	switch (node.type) {
		case 'Identifier':
			if (context[node.name] === undefined) {
				console.error("Context=", context);
				throw new Error("Unknown identifier '" + node.name + "'");
			}

			return context[node.name];

		case 'Literal':
			return node.value;

		case 'ConditionalExpression':
			var ret = evalExpression(node.test, context);
			if (ret) {
				return evalExpression(node.consequent, context);
			}

			return evalExpression(node.alternate, context);

		case 'BinaryExpression':
			var left = evalExpression(node.left, context);
			var right = evalExpression(node.right, context);

			switch (node.operator) {
				case '#':
					return left & (1 << right);

				case '+':
					return left + right;

				case '-':
					return left - right;

				case '|':
					return left | right;

				case '&':
					return left & right;

				case '/':
					return left / right;

				case '==':
					return left == right;

				case '===':
					return left === right;

				case '!=':
					return left != right;

				case '!==':
					return left !== right;

				case '<':
					return left < right;

				case '<=':
					return left <= right;

				case '>':
					return left > right;

				case '>=':
					return left >= right;

				case '>>':
					return left >> right;

				case '>>>':
					return left >>> right;

				case '<<':
					return left << right;

				default:
					throw new Error("Not supported operation '" + node.operator + "'");
			}

		case 'UnaryExpression':
			var exp = evalExpression(node.left, context);

			switch (node.operator) {
				case '-':
					return -exp;

				case '!':
					return !exp;

				case '~':
					return ~exp;

				case '+':
					return +exp;

				default:
					throw new Error("Not supported operation '" + node.operator + "'");
			}

	}
}

function execute(wordsToChange, body, expression, context) {
	var tree = jsep(expression);

	debug("Execute expression=", expression, " current=", context, " tree=", tree);

	if (tree.type === 'BinaryExpression') {

		var left = tree.left;
		var value = evalExpression(tree.right, context);

		if (left.type === 'Identifier') {
			var ret = /^W(\d+)$/.exec(left.name);
			if (!ret) {
				throw new Error("Unknown identifier " + left.name + "  (expression='" + expression + "')");
			}

			var idx = parseInt(ret[1], 10);

			debug("Change word W" + idx + " to ", value);

			wordsToChange[idx] = value;

			return;
		}

		if (left.type === 'BinaryExpression') {
			var left2 = left.left;

			if (left.operator === '#') {
				var value2 = evalExpression(left.right, context);

				var ret = /^W(\d+)$/.exec(left2.name);
				if (!ret) {
					throw new Error("Unknown identifier (2) " + left2.name + " (expression='" + expression + "')");
				}

				var idx = parseInt(ret[1], 10);

				var v = wordsToChange[idx] || 0;
				v &= ~(1 << value2);
				if (value) {
					v |= (1 << value2);
				}
				wordsToChange[idx] = v;

				debug("Change word W" + idx + "#" + value2 + " to ", value + " => ", v);

				return;
			}
		}
	}

	throw new Error("Unknown how to eval expression " + expression);
}

module.exports = Model;
