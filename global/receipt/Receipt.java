class Receipt {
    public static void main(String[] args) {
        int requiredVersion = 6;
        for (int visibleVersion : new int[] {5, 6, 7}) {
            System.out.println(visibleVersion < requiredVersion ? "ждать" : "готово");
        }
    }
}
