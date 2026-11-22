/* Example only: unsigned GCD, standard C99. */
static unsigned long long exam_gcd_u64(unsigned long long a, unsigned long long b) {
    while (b != 0) {
        unsigned long long remainder = a % b;
        a = b;
        b = remainder;
    }
    return a;
}
