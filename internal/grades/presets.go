package grades

// EngineVersion matches GRADES_ENGINE_VERSION in the TypeScript engine.
const EngineVersion = 1

// NamedGpaScale is a built-in GPA scale.
type NamedGpaScale struct {
	Name string `json:"name"`
	GpaScale
}

func bonus() map[string]Dec {
	return map[string]Dec{
		"regular": Zero, "honors": MustParse("0.5"), "ap": NewInt(1), "ib": NewInt(1), "dual": NewInt(1),
	}
}

var plusMinus = []string{"A", "A-", "B+", "B", "B-", "C+", "C", "C-", "D+", "D", "D-", "F"}

func pm(gpas ...string) []GradePoint {
	out := make([]GradePoint, len(plusMinus))
	for i, l := range plusMinus {
		out[i] = GradePoint{Letter: l, GPA: MustParse(gpas[i])}
	}
	return out
}

// GpaScales returns the built-in GPA scales by id. Each call returns fresh copies.
func GpaScales() map[string]NamedGpaScale {
	std := func() []GradePoint {
		return pm("4", "3.7", "3.3", "3", "2.7", "2.3", "2", "1.7", "1.3", "1", "0.7", "0")
	}
	return map[string]NamedGpaScale{
		"standard_plus_minus": {Name: "4.0 with ±", GpaScale: GpaScale{WeightedBonus: bonus(), Points: std()}},
		"flat_4": {Name: "4.0 flat", GpaScale: GpaScale{WeightedBonus: bonus(),
			Points: pm("4", "4", "3", "3", "3", "2", "2", "2", "1", "1", "1", "0")}},
		"plus_4_3": {Name: "4.3 (A+ = 4.3)", GpaScale: GpaScale{WeightedBonus: bonus(),
			Points: append([]GradePoint{{Letter: "A+", GPA: MustParse("4.3")}}, std()...)}},
		"five_point": {Name: "5.0", GpaScale: GpaScale{WeightedBonus: bonus(),
			Points: pm("5", "4.7", "4.3", "4", "3.7", "3.3", "3", "2.7", "2.3", "2", "1.7", "0")}},
	}
}
