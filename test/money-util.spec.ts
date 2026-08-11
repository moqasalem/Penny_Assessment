import { lineTotal, round2, sumMoney } from '../src/common/money.util';

describe('money utilities', () => {
	it('rounds common floating-point edge cases to cents', () => {
		expect(round2(0.005)).toBe(0.01);
		expect(sumMoney([0.57, 1.0])).toBe(1.57);
	});

	it('sums monetary values as cents to avoid accumulated float noise', () => {
		expect(sumMoney([lineTotal(3, 6.669), lineTotal(1, 0.1), lineTotal(1, 0.2)])).toBe(20.31);
	});
});
