/*jslint node: true, vars: true, nomen: true */
'use strict';

var async = require('async');
var jsep = require('jsep');
var Events = require('events');
var util = require('util');
var debug = require('debug')('tsx17:model');

var transactionId = 1;

function Model(commander, tsx, xpl, model, wordsToChange) {
	this.commander = commander;
	this.xpl = xpl;
	this.wordsToChange = wordsToChange;
	this.model = model;

	this.setMaxListeners(128);

	jsep.addBinaryOp('=', 20);
	jsep.addBinaryOp('#', 10);

	var units = model.units;

	var self = this;
	units.forEach(function(unit) {
		var status = unit.status;

		if (typeof (status) === "string") {
			self._addListener(unit, "status", status);

		} else {
			for ( var k in status) {
				self._addListener(unit, k, status[k]);
			}
		}

		var commands = unit.command;
		var keys = Object.keys(commands);
		for ( var k in keys) {
			if (k.indexOf('|') < 0) {
				continue;
			}

			var v = commands[k];
			k.split("|").forEach(function(n) {
				commands[n] = v;
			});

			delete k;
		}

		// console.error("Unknown type of status", status);
	});

	xpl.on("xpl:xpl-cmnd", function(message) {
		self.commandReceived(message);
	});

	this.once('words', function(words) {
		debug("Init words ", words);
		var ti = transactionId++;

		var ws = {};
		for (var j = 0; j < words.length; j++) {
			ws["W" + j] = words[j];
		}

		for (var i = 0; i < words.length; i++) {
			self.emit("W" + i, ws, ti);
		}
	});

	this.on('words', function(words, diff) {
		if (!diff || !diff.length) {
			return;
		}

		var ti = transactionId++;

		var ws = {};
		for (var j = 0; j < words.length; j++) {
			ws["W" + j] = words[j];
		}

		for (var i = 0; i < diff.length; i++) {
			var di = diff[i];

			debug("Emit change of #" + di.index + " " + di.value);

			self.emit("W" + di.index, ws, ti);
		}
	});
}

util.inherits(Model, Events.EventEmitter);

module.exports = Model;

Model.prototype._requestStatus = function(device) {
	var units = this.model.units;

	this.once('words', function(words) {

		var wordsByName = {};
		for (var j = 0; j < words.length; j++) {
			wordsByName["W" + j] = words[j];
		}

		console.log("Returns request status", wordsByName);

		var self = this;
		async.eachSeries(units, function(unit, callback) {

			async.forEachOfSeries(unit.$trees, function(tree, statusName, callback) {

				console.log("Unit ", unit, " status=", statusName);

				self._sendUnitStatus(unit, statusName, wordsByName, false, callback)
			}, callback);

		}, function(error) {
			console.error(error);
		});
	});

};

Model.prototype.commandReceived = function(message) {
	var body = message.body;

	if (!body) {
		debug("No body message=", message);
		return;
	}

	console.log("Received message", message);

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
	var type = body.type;
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

	var expression = commands[type];
	if (!expression) {
		debug("Command '" + type + "' is not found for device '" + device + "'", body);
		return;
	}

	if (unit.units === "%" && unit['0%'] !== undefined && unit['100%'] !== undefined) {
		current = parseFloat(current);
		if (isNaN(current)) {
			debug("Current is invalid for command '" + type + "' and device '" + device + "'", body);
			return;
		}

		current = Math.floor((current / 100) * (unit['100%'] - unit['0%']) + unit['0%']);
	}

	if (typeof (expression) === "string") {
		execute(wordsToChange, body, expression, current);
		return;
	}

	if (util.isArray(expression)) {
		for (var j = 0; j < expression.length; j++) {
			execute(wordsToChange, body, expression[j], current);
		}
		return;
	}

}

Model.prototype._addListener = function(unit, statusName, expression) {
	var tree = jsep(expression);
	tree.$expression = expression;

	if (!unit.$trees) {
		unit.$trees = {};
	}
	unit.$trees[statusName] = tree;

	var list = [];
	listIdentifiers(list, tree);

	debug("Expression", expression, ": register identifiers :", list);

	var self = this;
	list.forEach(function(identifier) {
		debug("Add listener " + identifier + " " + unit.device + "/" + statusName);
		self.on(identifier, self._createListener(unit, statusName, expression));
	});
}

Model.prototype._sendUnitStatus = function(unit, statusName, wordsByName, testIfSame, callback) {

	var tree = unit.$trees[statusName];

	var val = evalExpression(tree, wordsByName);

	console.log("Exp ", tree.$expression, /* wordsByName, */" =>", val);

	if (!unit._values) {
		unit._values = {};
	}

	if (testIfSame) {
		if (unit._values[statusName] === val) {
			return callback && callback();
		}

		unit._values[statusName] = val;
	}

	var trig = {
		device: unit.device,
		type: statusName,
	};

	if (unit.units === "%" && unit['0%'] !== undefined && unit['100%'] !== undefined) {
		val = Math.floor((val - unit['0%']) * 100 / (unit['100%'] - unit['0%']));
	}

	trig.current = val;

	if (unit.units) {
		trig.units = unit.units;
	}

	debug("Send stat ", trig);

	this.xpl.sendXplStat(trig, null, null, callback);
};

Model.prototype._createListener = function(unit, statusName) {
	var self = this;
	return function(wordsByName, transactionId) {
		var tree = unit.$trees[statusName];

		if (tree.$transactionId === transactionId) {
			return;
		}
		tree.$transactionId = transactionId;

		self._sendUnitStatus(unit, statusName, wordsByName, true);
	};
}

function listIdentifiers(list, node) {
	if (node.type === 'Identifier') {
		list.push(node.name);
		return;
	}

	for ( var k in node) {
		var n = node[k];

		if (typeof (n) === "object") {
			listIdentifiers(list, n);
		}
	}
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

function execute(wordsToChange, body, expression, current) {
	var tree = jsep(expression);

	if (tree.type === 'Identifier') {
		var ret = /^W(\\d+)$/.exec(tree.name);
		if (!ret) {
			throw new Error("Unknown identifier " + tree.name + "  (expression='" + expression + "')");
		}
	}
}
