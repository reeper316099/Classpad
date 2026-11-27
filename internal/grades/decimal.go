package grades

import (
	"encoding/json"
	"fmt"
	"math/big"
	"strconv"
	"strings"
)

// Precision is the number of significant digits every result is rounded to. It matches the
// TypeScript engine (decimal.js with precision 40, ROUND_HALF_UP), so both give the same digits.
const Precision = 40

// Rounding modes, named as in decimal.js.
type Rounding int

const (
	RoundHalfUp Rounding = iota // nearest; ties away from zero
	RoundDown                   // toward zero (truncate)
	RoundUp                     // away from zero
)

// Dec is an exact decimal number: coef × 10^exp. The zero value is 0. A Dec is never changed in
// place; every operation returns a new one.
type Dec struct {
	coef *big.Int
	exp  int
}

var (
	bigTen  = big.NewInt(10)
	bigOne  = big.NewInt(1)
	pow10s  = makePow10s(4 * Precision)
	Zero    = Dec{}
	Hundred = NewInt(100)
)

func makePow10s(n int) []*big.Int {
	t := []*big.Int{big.NewInt(1)}
	for len(t) < n {
		t = append(t, new(big.Int).Mul(t[len(t)-1], bigTen))
	}
	return t
}

// pow10 returns 10^n. The result is shared: never modify it.
func pow10(n int) *big.Int {
	if n < len(pow10s) {
		return pow10s[n]
	}
	return new(big.Int).Exp(bigTen, big.NewInt(int64(n)), nil)
}

// scaled returns n × 10^exp.
func scaled(n int64, exp int) Dec { return mk(big.NewInt(n), exp) }

// NewInt returns n as a Dec.
func NewInt(n int64) Dec { return mk(big.NewInt(n), 0) }

// MustParse parses s and panics if it is not a number. For constants and tests.
func MustParse(s string) Dec {
	d, err := Parse(s)
	if err != nil {
		panic(err)
	}
	return d
}

// Parse reads a decimal such as "-12.5", "1e-7" or "0.000". It keeps every digit given.
func Parse(s string) (Dec, error) {
	in := s
	s = strings.TrimSpace(s)
	neg := false
	if s != "" && (s[0] == '-' || s[0] == '+') {
		neg = s[0] == '-'
		s = s[1:]
	}
	exp := 0
	if i := strings.IndexAny(s, "eE"); i >= 0 {
		e, err := strconv.Atoi(s[i+1:])
		if err != nil {
			return Zero, fmt.Errorf("grades: bad number %q", in)
		}
		exp = e
		s = s[:i]
	}
	if i := strings.IndexByte(s, '.'); i >= 0 {
		exp -= len(s) - i - 1
		s = s[:i] + s[i+1:]
	}
	if s == "" {
		return Zero, fmt.Errorf("grades: bad number %q", in)
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return Zero, fmt.Errorf("grades: bad number %q", in)
		}
	}
	c, _ := new(big.Int).SetString(s, 10)
	if neg {
		c.Neg(c)
	}
	return mk(c, exp), nil
}

// mk normalizes (no trailing zeros in the coefficient). It takes ownership of c.
func mk(c *big.Int, exp int) Dec {
	if c.Sign() == 0 {
		return Dec{}
	}
	if c.Bit(0) == 1 { // odd: no trailing zero
		return Dec{coef: c, exp: exp}
	}
	if c.IsInt64() {
		v := c.Int64()
		if v%10 != 0 {
			return Dec{coef: c, exp: exp}
		}
		for v%10 == 0 {
			v /= 10
			exp++
		}
		return Dec{coef: c.SetInt64(v), exp: exp}
	}
	q, r := new(big.Int), new(big.Int)
	for {
		q.QuoRem(c, bigTen, r)
		if r.Sign() != 0 {
			break
		}
		c, q = q, c
		exp++
	}
	return Dec{coef: c, exp: exp}
}

func (d Dec) c() *big.Int {
	if d.coef == nil {
		return new(big.Int)
	}
	return d.coef
}

func numDigits(x *big.Int) int {
	if x.Sign() == 0 {
		return 1
	}
	n := int(float64(x.BitLen()-1)*0.30102999566398120) + 1 // estimate, may be one short
	if x.CmpAbs(pow10(n)) >= 0 {
		n++
	}
	return n
}

// roundCoef drops the last `drop` digits of c, rounding by mode. sticky says digits that were
// already dropped (beyond c) were not all zero. c is not changed.
func roundCoef(c *big.Int, drop int, mode Rounding, sticky bool) *big.Int {
	if drop <= 0 {
		return c
	}
	// QuoRem truncates toward zero, and r takes c's sign.
	q, r := new(big.Int).QuoRem(c, pow10(drop), new(big.Int))
	up := false
	switch mode {
	case RoundHalfUp:
		up = r.CmpAbs(half(drop)) >= 0
	case RoundUp:
		up = r.Sign() != 0 || sticky
	}
	if up {
		if c.Sign() < 0 {
			q.Sub(q, bigOne)
		} else {
			q.Add(q, bigOne)
		}
	}
	return q
}

var halves = func() []*big.Int {
	t := make([]*big.Int, len(pow10s))
	for i := 1; i < len(t); i++ {
		t[i] = new(big.Int).Mul(big.NewInt(5), pow10s[i-1])
	}
	return t
}()

// half returns 5 × 10^(n−1), half of 10^n (n ≥ 1). Shared: never modify it.
func half(n int) *big.Int {
	if n < len(halves) {
		return halves[n]
	}
	return new(big.Int).Mul(big.NewInt(5), pow10(n-1))
}

// finish rounds c × 10^exp to Precision significant digits (round half up).
func finish(c *big.Int, exp int, sticky bool) Dec {
	if drop := numDigits(c) - Precision; drop > 0 {
		c = roundCoef(c, drop, RoundHalfUp, sticky)
		exp += drop
	}
	return mk(c, exp)
}

// Add returns d + e.
func (d Dec) Add(e Dec) Dec {
	if d.coef == nil {
		return finish(new(big.Int).Set(e.c()), e.exp, false)
	}
	if e.coef == nil {
		return finish(new(big.Int).Set(d.c()), d.exp, false)
	}
	a, b := d, e
	if a.exp < b.exp {
		a, b = b, a
	}
	x := new(big.Int).Mul(a.coef, pow10(a.exp-b.exp))
	return finish(x.Add(x, b.coef), b.exp, false)
}

// Sub returns d − e.
func (d Dec) Sub(e Dec) Dec { return d.Add(e.Neg()) }

// Neg returns −d.
func (d Dec) Neg() Dec {
	if d.coef == nil {
		return d
	}
	return Dec{coef: new(big.Int).Neg(d.coef), exp: d.exp}
}

// Mul returns d × e.
func (d Dec) Mul(e Dec) Dec {
	if d.coef == nil || e.coef == nil {
		return Zero
	}
	return finish(new(big.Int).Mul(d.coef, e.coef), d.exp+e.exp, false)
}

// Quo returns d ÷ e, correctly rounded to Precision digits. Dividing by zero returns zero; the
// engine checks every divisor first, so it never happens there.
func (d Dec) Quo(e Dec) Dec {
	if d.coef == nil || e.coef == nil {
		return Zero
	}
	k := Precision + 2 + numDigits(e.coef) - numDigits(d.coef)
	if k < 0 {
		k = 0
	}
	num := new(big.Int).Mul(d.coef, pow10(k))
	q, r := num.QuoRem(num, e.coef, new(big.Int)) // truncates toward zero; q takes the sign
	return finish(q, d.exp-e.exp-k, r.Sign() != 0)
}

// Cmp returns −1, 0 or +1.
func (d Dec) Cmp(e Dec) int {
	ds, es := d.Sign(), e.Sign()
	if ds != es || ds == 0 {
		switch {
		case ds < es:
			return -1
		case ds > es:
			return 1
		}
		return 0
	}
	if d.exp == e.exp {
		return d.coef.Cmp(e.coef)
	}
	// Different leading-digit positions decide it without scaling.
	if ad, ae := numDigits(d.coef)+d.exp, numDigits(e.coef)+e.exp; ad != ae {
		if ad > ae {
			return ds
		}
		return -ds
	}
	if d.exp > e.exp {
		return new(big.Int).Mul(d.coef, pow10(d.exp-e.exp)).Cmp(e.coef)
	}
	return d.coef.Cmp(new(big.Int).Mul(e.coef, pow10(e.exp-d.exp)))
}

func (d Dec) Sign() int {
	if d.coef == nil {
		return 0
	}
	return d.coef.Sign()
}

func (d Dec) Eq(e Dec) bool  { return d.Cmp(e) == 0 }
func (d Dec) Lt(e Dec) bool  { return d.Cmp(e) < 0 }
func (d Dec) Lte(e Dec) bool { return d.Cmp(e) <= 0 }
func (d Dec) Gt(e Dec) bool  { return d.Cmp(e) > 0 }
func (d Dec) Gte(e Dec) bool { return d.Cmp(e) >= 0 }
func (d Dec) IsZero() bool   { return d.coef == nil }

// Abs returns |d|.
func (d Dec) Abs() Dec {
	if d.Sign() < 0 {
		return d.Neg()
	}
	return d
}

// RoundDP rounds to dp decimal places (decimal.js toDecimalPlaces).
func (d Dec) RoundDP(dp int, mode Rounding) Dec {
	if d.coef == nil || d.exp >= -dp {
		return d
	}
	return mk(roundCoef(d.coef, -dp-d.exp, mode, false), -dp)
}

// String prints like decimal.js toString: plain digits, or exponent form when the leading digit
// is at 10^21 or above, or at 10^-7 or below. No trailing zeros.
func (d Dec) String() string {
	if d.coef == nil {
		return "0"
	}
	digits := new(big.Int).Abs(d.coef).String()
	sign := ""
	if d.coef.Sign() < 0 {
		sign = "-"
	}
	e := len(digits) - 1 + d.exp // exponent of the leading digit
	if e <= -7 || e >= 21 {
		s := digits[:1]
		if len(digits) > 1 {
			s += "." + digits[1:]
		}
		if e < 0 {
			return sign + s + "e-" + strconv.Itoa(-e)
		}
		return sign + s + "e+" + strconv.Itoa(e)
	}
	switch {
	case d.exp >= 0:
		return sign + digits + strings.Repeat("0", d.exp)
	case e >= 0:
		return sign + digits[:e+1] + "." + digits[e+1:]
	default:
		return sign + "0." + strings.Repeat("0", -e-1) + digits
	}
}

// MarshalJSON writes the number as a string, like decimal.js does, so no digits are lost.
func (d Dec) MarshalJSON() ([]byte, error) { return json.Marshal(d.String()) }

// UnmarshalJSON accepts a JSON number or a numeric string.
func (d *Dec) UnmarshalJSON(b []byte) error {
	s := string(b)
	if len(b) > 0 && b[0] == '"' {
		if err := json.Unmarshal(b, &s); err != nil {
			return err
		}
	}
	v, err := Parse(s)
	if err != nil {
		return err
	}
	*d = v
	return nil
}

// Float64 is for display and tests only.
func (d Dec) Float64() float64 {
	f, _ := strconv.ParseFloat(d.String(), 64)
	return f
}

// format shows a number the way step breakdowns do: at most dp decimal places, no trailing zeros,
// "—" for no value.
func format(d *Dec, dp int) string {
	if d == nil {
		return "—"
	}
	return d.RoundDP(dp, RoundHalfUp).String()
}

func f6(d Dec) string  { return format(&d, 6) }
func fp(d *Dec) string { return format(d, 6) }
func ptr(d Dec) *Dec   { return &d }
func decInt(n int) Dec { return NewInt(int64(n)) }
func dOr(p *Dec, def Dec) Dec {
	if p == nil {
		return def
	}
	return *p
}
