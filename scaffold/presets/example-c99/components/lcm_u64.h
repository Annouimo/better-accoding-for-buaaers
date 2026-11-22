/* Example only. Caller must ensure the result fits unsigned long long. */
static unsigned long long exam_lcm_u64(unsigned long long a, unsigned long long b) {
    if (a == 0 || b == 0) return 0;
    return (a / exam_gcd_u64(a, b)) * b;
}
