import { Type } from "typebox";
import { Check } from "typebox/value";

const RecordSchema = Type.Object({}, { additionalProperties: true });
const StringSchema = Type.String();
const NumberSchema = Type.Number();
const BooleanSchema = Type.Boolean();
const FunctionSchema = Type.Function([], Type.Unknown());

export function isRecordValue<Contract, T = unknown>(
	value: T | Contract,
): value is (T | Contract) & Contract {
	return Check(RecordSchema, value);
}

export function isStringValue<T>(value: T): value is T & string {
	return Check(StringSchema, value);
}

export function isNumberValue<T>(value: T): value is T & number {
	return Check(NumberSchema, value);
}

export function isBooleanValue<T>(value: T): value is T & boolean {
	return Check(BooleanSchema, value);
}

export function isFunctionValue<T>(value: T): value is T & ((...args: never[]) => void) {
	return Check(FunctionSchema, value);
}
